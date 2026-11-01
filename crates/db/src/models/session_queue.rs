use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Sqlite};
use uuid::Uuid;

/// A message sent to a session while one of its turns was in flight.
///
/// Queued messages become turns one at a time, in queue order, each when the
/// session is idle again. A message joins at the end; a person can reorder
/// the queue. Order is `seq`, with insertion order (`rowid`) breaking ties so
/// it stays strict even when two messages land in the same millisecond.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct SessionQueueItem {
    pub id: Uuid,
    pub task_id: Uuid,
    pub prompt: String,
    /// Place in the queue: lower goes first. Only the order means anything.
    pub seq: i64,
    /// How the message is to be sent, as JSON the runtime owns; `None` sends
    /// plain text continuing the session. Internal, so not on the wire.
    #[serde(skip)]
    pub options: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl SessionQueueItem {
    /// Append `prompt` to the session's queue and return its 1-based position.
    pub async fn enqueue(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        prompt: &str,
        options: Option<&str>,
    ) -> Result<(Self, u32), sqlx::Error> {
        let mut tx = pool.begin().await?;
        let item = sqlx::query_as::<_, Self>(
            "INSERT INTO session_queue (id, task_id, prompt, options, seq) \
             VALUES (?, ?, ?, ?, \
                 (SELECT COALESCE(MAX(seq), 0) + 1 FROM session_queue WHERE task_id = ?)) \
             RETURNING *",
        )
        .bind(Uuid::new_v4())
        .bind(task_id)
        .bind(prompt)
        .bind(options)
        .bind(task_id)
        .fetch_one(&mut *tx)
        .await?;
        let position: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM session_queue WHERE task_id = ?")
                .bind(task_id)
                .fetch_one(&mut *tx)
                .await?;
        tx.commit().await?;
        Ok((item, position as u32))
    }

    pub async fn count(pool: &Pool<Sqlite>, task_id: Uuid) -> Result<u32, sqlx::Error> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_queue WHERE task_id = ?")
            .bind(task_id)
            .fetch_one(pool)
            .await?;
        Ok(count as u32)
    }

    /// The session's next message, left in the queue.
    ///
    /// A message leaves the queue only after its turn exists (see
    /// [`Self::remove`]), so an observer never sees the session idle with an
    /// empty queue while a queued message is on its way to becoming a turn.
    pub async fn front(pool: &Pool<Sqlite>, task_id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT * FROM session_queue WHERE task_id = ? ORDER BY seq, rowid LIMIT 1",
        )
        .bind(task_id)
        .fetch_optional(pool)
        .await
    }

    /// The session's queue, in the order its messages become turns.
    pub async fn list_by_task(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT * FROM session_queue WHERE task_id = ? ORDER BY seq, rowid",
        )
        .bind(task_id)
        .fetch_all(pool)
        .await
    }

    pub async fn list_all(pool: &Pool<Sqlite>) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM session_queue ORDER BY task_id, seq, rowid")
            .fetch_all(pool)
            .await
    }

    pub async fn find_by_rowid(
        pool: &Pool<Sqlite>,
        rowid: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM session_queue WHERE rowid = ?")
            .bind(rowid)
            .fetch_optional(pool)
            .await
    }

    /// Put the session's queue in the order of `ids`. Refused (`false`, nothing
    /// changed) unless `ids` names exactly the messages waiting now: a message
    /// that started or arrived since the caller read the queue means the
    /// caller's order is stale.
    pub async fn reorder(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        ids: &[Uuid],
    ) -> Result<bool, sqlx::Error> {
        let mut tx = pool.begin().await?;
        let mut waiting: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM session_queue WHERE task_id = ?")
                .bind(task_id)
                .fetch_all(&mut *tx)
                .await?;
        let mut proposed = ids.to_vec();
        waiting.sort();
        proposed.sort();
        if waiting != proposed {
            return Ok(false);
        }
        for (place, id) in ids.iter().enumerate() {
            sqlx::query("UPDATE session_queue SET seq = ? WHERE id = ?")
                .bind(place as i64 + 1)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(true)
    }

    /// Make `id` the session's next message. Returns whether it was waiting.
    pub async fn move_to_front(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            "UPDATE session_queue \
             SET seq = (SELECT MIN(seq) - 1 FROM session_queue WHERE task_id = ?) \
             WHERE id = ? AND task_id = ?",
        )
        .bind(task_id)
        .bind(id)
        .bind(task_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Replace a waiting message's text; its place and options stay. Returns
    /// whether it was still waiting.
    pub async fn update_prompt(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        id: Uuid,
        prompt: &str,
    ) -> Result<bool, sqlx::Error> {
        let result =
            sqlx::query("UPDATE session_queue SET prompt = ? WHERE id = ? AND task_id = ?")
                .bind(prompt)
                .bind(id)
                .bind(task_id)
                .execute(pool)
                .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn remove(pool: &Pool<Sqlite>, id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM session_queue WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{models::task::TaskRecord, DBService};
    use tempfile::tempdir;

    async fn setup() -> (tempfile::TempDir, Pool<Sqlite>, Uuid) {
        let dir = tempdir().unwrap();
        let db = DBService::new_with_path(&dir.path().join("test.db"))
            .await
            .unwrap();
        let pool = db.pool().clone();
        let project_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path, created_at, updated_at)
             VALUES (?, 'proj', '/tmp/repo', datetime('now'), datetime('now'))",
        )
        .bind(project_id)
        .execute(&pool)
        .await
        .unwrap();
        let task = TaskRecord::new(project_id, "Task", None);
        task.insert(&pool).await.unwrap();
        (dir, pool, task.id)
    }

    #[tokio::test]
    async fn messages_leave_in_the_order_they_arrived() {
        let (_dir, pool, task_id) = setup().await;
        let (_, first) = SessionQueueItem::enqueue(&pool, task_id, "one", None)
            .await
            .unwrap();
        let (_, second) = SessionQueueItem::enqueue(&pool, task_id, "two", None)
            .await
            .unwrap();
        assert_eq!((first, second), (1, 2));
        assert_eq!(SessionQueueItem::count(&pool, task_id).await.unwrap(), 2);

        let head = SessionQueueItem::front(&pool, task_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(head.prompt, "one");
        SessionQueueItem::remove(&pool, head.id).await.unwrap();
        let head = SessionQueueItem::front(&pool, task_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(head.prompt, "two");
        SessionQueueItem::remove(&pool, head.id).await.unwrap();
        assert!(SessionQueueItem::front(&pool, task_id)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn a_message_keeps_how_it_is_to_be_sent() {
        let (_dir, pool, task_id) = setup().await;
        SessionQueueItem::enqueue(&pool, task_id, "plain", None)
            .await
            .unwrap();
        SessionQueueItem::enqueue(&pool, task_id, "rich", Some(r#"{"mode":"new"}"#))
            .await
            .unwrap();

        let queue = SessionQueueItem::list_by_task(&pool, task_id)
            .await
            .unwrap();
        assert_eq!(queue[0].options, None);
        assert_eq!(queue[1].options.as_deref(), Some(r#"{"mode":"new"}"#));
    }

    async fn prompts(pool: &Pool<Sqlite>, task_id: Uuid) -> Vec<String> {
        SessionQueueItem::list_by_task(pool, task_id)
            .await
            .unwrap()
            .into_iter()
            .map(|item| item.prompt)
            .collect()
    }

    async fn enqueue_all(pool: &Pool<Sqlite>, task_id: Uuid, prompts: &[&str]) -> Vec<Uuid> {
        let mut ids = Vec::new();
        for prompt in prompts {
            let (item, _) = SessionQueueItem::enqueue(pool, task_id, prompt, None)
                .await
                .unwrap();
            ids.push(item.id);
        }
        ids
    }

    #[tokio::test]
    async fn a_reordered_queue_leaves_in_its_new_order() {
        let (_dir, pool, task_id) = setup().await;
        let ids = enqueue_all(&pool, task_id, &["one", "two", "three"]).await;

        let reordered = SessionQueueItem::reorder(&pool, task_id, &[ids[2], ids[0], ids[1]])
            .await
            .unwrap();
        assert!(reordered);
        assert_eq!(prompts(&pool, task_id).await, ["three", "one", "two"]);
        let head = SessionQueueItem::front(&pool, task_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(head.prompt, "three");

        // A message sent afterwards still goes last.
        enqueue_all(&pool, task_id, &["four"]).await;
        assert_eq!(
            prompts(&pool, task_id).await,
            ["three", "one", "two", "four"]
        );
    }

    #[tokio::test]
    async fn a_reorder_from_a_stale_view_changes_nothing() {
        let (_dir, pool, task_id) = setup().await;
        let ids = enqueue_all(&pool, task_id, &["one", "two"]).await;

        // A message started (left the queue) since the order was read.
        let missing_one = [ids[1], ids[0], Uuid::new_v4()];
        assert!(!SessionQueueItem::reorder(&pool, task_id, &missing_one)
            .await
            .unwrap());
        // A message arrived since the order was read.
        assert!(!SessionQueueItem::reorder(&pool, task_id, &[ids[1]])
            .await
            .unwrap());
        // The same message twice.
        assert!(
            !SessionQueueItem::reorder(&pool, task_id, &[ids[1], ids[1]])
                .await
                .unwrap()
        );
        assert_eq!(prompts(&pool, task_id).await, ["one", "two"]);
    }

    #[tokio::test]
    async fn a_message_moved_to_the_front_goes_next() {
        let (_dir, pool, task_id) = setup().await;
        let ids = enqueue_all(&pool, task_id, &["one", "two", "three"]).await;

        assert!(SessionQueueItem::move_to_front(&pool, task_id, ids[2])
            .await
            .unwrap());
        assert_eq!(prompts(&pool, task_id).await, ["three", "one", "two"]);
        assert!(
            !SessionQueueItem::move_to_front(&pool, task_id, Uuid::new_v4())
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn an_edited_message_keeps_its_place_and_how_it_is_sent() {
        let (_dir, pool, task_id) = setup().await;
        SessionQueueItem::enqueue(&pool, task_id, "one", None)
            .await
            .unwrap();
        let (item, _) = SessionQueueItem::enqueue(&pool, task_id, "two", Some(r#"{"mode":"new"}"#))
            .await
            .unwrap();
        enqueue_all(&pool, task_id, &["three"]).await;

        assert!(
            SessionQueueItem::update_prompt(&pool, task_id, item.id, "two, revised")
                .await
                .unwrap()
        );
        assert_eq!(
            prompts(&pool, task_id).await,
            ["one", "two, revised", "three"]
        );
        let queue = SessionQueueItem::list_by_task(&pool, task_id)
            .await
            .unwrap();
        assert_eq!(queue[1].options.as_deref(), Some(r#"{"mode":"new"}"#));

        // Gone (started or withdrawn): nothing to edit.
        assert!(
            !SessionQueueItem::update_prompt(&pool, task_id, Uuid::new_v4(), "x")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn looking_at_the_head_does_not_take_it() {
        let (_dir, pool, task_id) = setup().await;
        SessionQueueItem::enqueue(&pool, task_id, "one", None)
            .await
            .unwrap();
        SessionQueueItem::front(&pool, task_id).await.unwrap();
        assert_eq!(SessionQueueItem::count(&pool, task_id).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn queues_are_per_session() {
        let (_dir, pool, task_id) = setup().await;
        let project_id: Uuid = sqlx::query_scalar("SELECT project_id FROM task_records")
            .fetch_one(&pool)
            .await
            .unwrap();
        let other = TaskRecord::new(project_id, "Other", None);
        other.insert(&pool).await.unwrap();

        SessionQueueItem::enqueue(&pool, task_id, "mine", None)
            .await
            .unwrap();
        assert!(SessionQueueItem::front(&pool, other.id)
            .await
            .unwrap()
            .is_none());
        assert_eq!(SessionQueueItem::count(&pool, task_id).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn deleting_the_session_drops_its_queue() {
        let (_dir, pool, task_id) = setup().await;
        SessionQueueItem::enqueue(&pool, task_id, "one", None)
            .await
            .unwrap();
        sqlx::query("DELETE FROM task_records WHERE id = ?")
            .bind(task_id)
            .execute(&pool)
            .await
            .unwrap();
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_queue")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
    }
}
