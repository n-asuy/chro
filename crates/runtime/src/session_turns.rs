//! One turn at a time per session.
//!
//! Every turn on an existing session starts here: a message from the app, the
//! operator API, or a delegation wake, and the next queued message. Each
//! decision runs under the session's turn lock, so two senders (or a sender
//! and the queue) can never both see the session idle and both start a turn
//! that races the other over the same worktree and agent session.
//!
//! A message that may wait joins the session's queue and becomes the next turn
//! when the current one ends; one that may not is refused with
//! [`RuntimeError::SessionBusy`].

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use anyhow::Context;
use db::models::{SessionQueueItem, TaskRecord, TaskRun};
use tokio::sync::Mutex as AsyncMutex;
use tracing::{info, warn};
use uuid::Uuid;

use crate::{
    tasks::{MessageOptions, SendTaskMessageParams, TaskMessageStart, TaskService},
    Runtime, RuntimeError,
};

/// What happened to a message sent with [`TaskService::send_or_queue`].
#[derive(Debug)]
pub enum SendOutcome {
    /// The session was idle and the message started a turn.
    Started(Box<TaskMessageStart>),
    /// The session was busy; the message waits at this 1-based position.
    Queued { position: u32 },
}

fn turn_lock(task_id: Uuid) -> Arc<AsyncMutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<Uuid, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .expect("turn lock table")
        .entry(task_id)
        .or_default()
        .clone()
}

/// The queue's form of a message's options: nothing for a plain message.
fn stored_options(options: &MessageOptions) -> Result<Option<String>, RuntimeError> {
    if *options == MessageOptions::default() {
        return Ok(None);
    }
    let json = serde_json::to_string(options).context("encode queued message options")?;
    Ok(Some(json))
}

/// The options a queued message was sent with.
fn queued_options(stored: Option<&str>) -> Result<MessageOptions, RuntimeError> {
    let Some(json) = stored else {
        return Ok(MessageOptions::default());
    };
    Ok(serde_json::from_str(json).context("decode queued message options")?)
}

/// What to do with a message, given the session's state.
#[derive(Debug, PartialEq, Eq)]
enum Admission {
    Start,
    Queue,
    Busy,
}

/// A message starts a turn only when nothing is in flight and nothing is
/// waiting ahead of it; otherwise it queues if allowed, or is refused.
fn admit(turn_in_flight: bool, waiting: u32, may_queue: bool) -> Admission {
    if !turn_in_flight && waiting == 0 {
        Admission::Start
    } else if may_queue {
        Admission::Queue
    } else {
        Admission::Busy
    }
}

impl<R: Runtime> TaskService<'_, R> {
    /// True while one of the session's turns is pending or running.
    pub async fn turn_in_flight(&self, task_id: Uuid) -> Result<bool, RuntimeError> {
        let active: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM task_runs \
             WHERE task_id = ? AND status IN ('running', 'pending') AND dropped = 0",
        )
        .bind(task_id)
        .fetch_one(self.pool())
        .await?;
        Ok(active > 0)
    }

    /// Start a turn with `params` if the session is idle with nothing queued,
    /// and fail with [`RuntimeError::SessionBusy`] otherwise. The app's
    /// composer sends this way to an idle session; while a turn runs it
    /// queues through [`Self::send_or_queue`].
    pub async fn send_task_message(
        &self,
        params: SendTaskMessageParams,
    ) -> Result<TaskMessageStart, RuntimeError> {
        let lock = turn_lock(params.task_id);
        let _guard = lock.lock().await;
        match self.admission(params.task_id, false).await? {
            (Admission::Start, _) => self.start_turn(params).await,
            _ => Err(RuntimeError::SessionBusy),
        }
    }

    /// Deliver the message to its session: start a turn when it is idle, queue
    /// it behind the current turn when it is busy and `queue` allows, and fail
    /// with [`RuntimeError::SessionBusy`] otherwise.
    ///
    /// Messages already queued keep their place: an idle session with a
    /// non-empty queue queues this one too and starts the oldest.
    pub async fn send_or_queue(
        &self,
        params: SendTaskMessageParams,
        queue: bool,
    ) -> Result<SendOutcome, RuntimeError> {
        let task_id = params.task_id;
        let lock = turn_lock(task_id);
        let _guard = lock.lock().await;
        let (admission, busy) = self.admission(task_id, queue).await?;
        match admission {
            Admission::Start => {
                let start = self.start_turn(params).await?;
                Ok(SendOutcome::Started(Box::new(start)))
            }
            Admission::Busy => Err(RuntimeError::SessionBusy),
            Admission::Queue => {
                // Uploaded images nothing links to are swept by housekeeping;
                // link them now so they outlive the wait.
                if let Some(ids) = params
                    .options
                    .image_ids
                    .as_deref()
                    .filter(|ids| !ids.is_empty())
                {
                    self.runtime()
                        .image()
                        .link_images_to_task(task_id, ids)
                        .await?;
                }
                let options = stored_options(&params.options)?;
                let (_, position) = SessionQueueItem::enqueue(
                    self.pool(),
                    task_id,
                    &params.prompt,
                    options.as_deref(),
                )
                .await?;
                if busy {
                    return Ok(SendOutcome::Queued { position });
                }
                // Idle with a backlog: the backlog goes first, in order.
                self.start_next_queued(task_id).await?;
                Ok(SendOutcome::Queued {
                    position: position.saturating_sub(1),
                })
            }
        }
    }

    /// The admission for a message to `task_id`, and whether a turn is in
    /// flight. Caller holds the turn lock.
    async fn admission(
        &self,
        task_id: Uuid,
        may_queue: bool,
    ) -> Result<(Admission, bool), RuntimeError> {
        let busy = self.turn_in_flight(task_id).await?;
        let waiting = SessionQueueItem::count(self.pool(), task_id).await?;
        Ok((admit(busy, waiting, may_queue), busy))
    }

    /// Start the session's oldest queued message as a turn if the session is
    /// idle. Returns the started turn, if any.
    pub async fn drain_session_queue(
        &self,
        task_id: Uuid,
    ) -> Result<Option<TaskMessageStart>, RuntimeError> {
        let lock = turn_lock(task_id);
        let _guard = lock.lock().await;
        if self.turn_in_flight(task_id).await? {
            return Ok(None);
        }
        self.start_next_queued(task_id).await
    }

    /// Withdraw one queued message before it becomes a turn. Returns whether
    /// it was still waiting (it may already have started).
    pub async fn withdraw_queued(
        &self,
        task_id: Uuid,
        item_id: Uuid,
    ) -> Result<bool, RuntimeError> {
        let lock = turn_lock(task_id);
        let _guard = lock.lock().await;
        let result = sqlx::query("DELETE FROM session_queue WHERE id = ? AND task_id = ?")
            .bind(item_id)
            .bind(task_id)
            .execute(self.pool())
            .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Replace the text of a message still waiting; its place, images,
    /// references and skills stay.
    pub async fn edit_queued(
        &self,
        task_id: Uuid,
        item_id: Uuid,
        prompt: &str,
    ) -> Result<(), RuntimeError> {
        if prompt.trim().is_empty() {
            return Err(RuntimeError::BadRequest("prompt is required"));
        }
        let lock = turn_lock(task_id);
        let _guard = lock.lock().await;
        if !SessionQueueItem::update_prompt(self.pool(), task_id, item_id, prompt).await? {
            return Err(RuntimeError::NotFound("queued message"));
        }
        Ok(())
    }

    /// Put the session's queue in the order of `item_ids`, which must name
    /// exactly the messages waiting now; otherwise
    /// [`RuntimeError::QueueChanged`] and nothing moves.
    pub async fn reorder_queue(
        &self,
        task_id: Uuid,
        item_ids: &[Uuid],
    ) -> Result<(), RuntimeError> {
        let lock = turn_lock(task_id);
        let _guard = lock.lock().await;
        if !SessionQueueItem::reorder(self.pool(), task_id, item_ids).await? {
            return Err(RuntimeError::QueueChanged);
        }
        Ok(())
    }

    /// Send a waiting message now: it moves to the front, the turn in flight
    /// is stopped, and the message starts as the next turn. Returns whether
    /// it started (it stays at the front if the stopped turn is still
    /// winding down).
    ///
    /// All of it runs under the turn lock, so the stopped turn's own
    /// settlement waits and then finds the session busy with this message,
    /// rather than racing it, and nothing stops a turn this started.
    pub async fn send_queued_now(
        &self,
        task_id: Uuid,
        item_id: Uuid,
    ) -> Result<bool, RuntimeError> {
        let lock = turn_lock(task_id);
        let _guard = lock.lock().await;
        if !SessionQueueItem::move_to_front(self.pool(), task_id, item_id).await? {
            return Err(RuntimeError::NotFound("queued message"));
        }
        let in_flight: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM task_runs \
             WHERE task_id = ? AND status IN ('running', 'pending') AND dropped = 0",
        )
        .bind(task_id)
        .fetch_all(self.pool())
        .await?;
        for run_id in in_flight {
            self.runtime().cancel_execution(run_id).await?;
        }
        if self.turn_in_flight(task_id).await? {
            return Ok(false);
        }
        Ok(self.start_next_queued(task_id).await?.is_some())
    }

    /// Drop every message waiting in the session's queue; returns how many.
    pub async fn clear_session_queue(&self, task_id: Uuid) -> Result<u64, RuntimeError> {
        let lock = turn_lock(task_id);
        let _guard = lock.lock().await;
        let result = sqlx::query("DELETE FROM session_queue WHERE task_id = ?")
            .bind(task_id)
            .execute(self.pool())
            .await?;
        Ok(result.rows_affected())
    }

    /// Everything that follows a finished run, in order:
    ///
    /// 1. If the run's session was delegated, hand its result back to the
    ///    delegating session (which may wake it).
    /// 2. The finished session takes its next queued message.
    /// 3. If the finished session itself delegated work and a wake was
    ///    deferred because it was mid-turn, deliver it now.
    ///
    /// Steps 2 and 3 both start turns; whichever runs first makes the other
    /// see a busy session and defer to the next finished run.
    pub async fn settle_after_run(&self, run_id: Uuid) -> Result<(), RuntimeError> {
        let run = TaskRun::get(self.pool(), run_id).await?;
        if let Err(err) = self.settle_delegation_handoff(run_id).await {
            warn!(%run_id, error = %err, "delegation handoff settlement failed");
        }
        match self.drain_session_queue(run.task_id).await {
            Ok(Some(start)) => info!(
                task_id = %run.task_id,
                task_run_id = %start.execution.task_run.id,
                "started the next queued message"
            ),
            Ok(None) => {}
            Err(err) => warn!(task_id = %run.task_id, error = %err, "queued message did not start"),
        }
        let task = TaskRecord::get(self.pool(), run.task_id).await?;
        self.try_delegation_barrier_wake(&task).await
    }

    /// Caller holds the turn lock and has checked the session is idle.
    ///
    /// The message stays queued until its turn exists, so the session never
    /// looks idle with an empty queue in between (a `wait --for idle` would
    /// return in that gap). If the turn cannot start, the message simply stays
    /// at the head; `cancel` clears a stuck queue.
    async fn start_next_queued(
        &self,
        task_id: Uuid,
    ) -> Result<Option<TaskMessageStart>, RuntimeError> {
        let Some(item) = SessionQueueItem::front(self.pool(), task_id).await? else {
            return Ok(None);
        };
        let start = self
            .start_turn(SendTaskMessageParams {
                task_id,
                prompt: item.prompt.clone(),
                options: queued_options(item.options.as_deref())?,
            })
            .await?;
        SessionQueueItem::remove(self.pool(), item.id).await?;
        Ok(Some(start))
    }
}

#[cfg(test)]
mod tests {
    use db::models::TaskContextRefInput;

    use super::*;
    use crate::tasks::TaskMessageMode;

    #[test]
    fn an_idle_session_with_nothing_waiting_starts_the_turn() {
        assert_eq!(admit(false, 0, true), Admission::Start);
        assert_eq!(admit(false, 0, false), Admission::Start);
    }

    #[test]
    fn a_busy_session_queues_or_refuses() {
        assert_eq!(admit(true, 0, true), Admission::Queue);
        assert_eq!(admit(true, 0, false), Admission::Busy);
    }

    #[test]
    fn waiting_messages_go_first_so_nothing_jumps_the_queue() {
        // Idle with a backlog (its head failed to start): a new message must
        // not overtake it, whether it may queue or not.
        assert_eq!(admit(false, 1, true), Admission::Queue);
        assert_eq!(admit(false, 1, false), Admission::Busy);
        assert_eq!(admit(true, 2, false), Admission::Busy);
    }

    #[test]
    fn a_queued_message_is_sent_the_way_it_was_written() {
        let options = MessageOptions {
            mode: TaskMessageMode::New,
            image_ids: Some(vec![Uuid::new_v4()]),
            selected_skill_ids: vec!["review".into()],
            context_refs: vec![TaskContextRefInput::session(Uuid::new_v4(), None)],
            target_branch: Some("main".into()),
            ..MessageOptions::default()
        };
        let stored = stored_options(&options).unwrap();
        assert!(stored.is_some());
        assert_eq!(queued_options(stored.as_deref()).unwrap(), options);
    }

    #[test]
    fn a_plain_message_stores_no_options() {
        assert_eq!(stored_options(&MessageOptions::default()).unwrap(), None);
        assert_eq!(queued_options(None).unwrap(), MessageOptions::default());
    }

    #[tokio::test]
    async fn the_turn_lock_is_shared_per_session_and_distinct_across_sessions() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        assert!(Arc::ptr_eq(&turn_lock(a), &turn_lock(a)));
        assert!(!Arc::ptr_eq(&turn_lock(a), &turn_lock(b)));

        let held = turn_lock(a);
        let _guard = held.lock().await;
        assert!(turn_lock(a).try_lock().is_err(), "same session must wait");
        assert!(turn_lock(b).try_lock().is_ok(), "other sessions must not");
    }
}
