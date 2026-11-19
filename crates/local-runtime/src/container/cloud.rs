use super::*;
use crate::cloud::{self, CloudClient};
use reqwest::Method;
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

#[derive(Deserialize)]
struct Snapshot {
    logs: Vec<LogEntry>,
    log_cursor: u64,
    status: RunStatus,
    settled: bool,
    approvals: Vec<approvals::ApprovalPendingInfo>,
}

impl LocalContainerService {
    pub(super) async fn run_cloud_execution(
        &self,
        params: ExecutionStartParams,
        events_tx: broadcast::Sender<ExecutionEvent>,
        mut cancel: oneshot::Receiver<()>,
        store: Arc<MsgStore>,
    ) -> Result<(), ContainerError> {
        let run_id = params.task_run_id;
        let (agent, agent_kind) = self.create_agent_for_run(run_id).await?;
        agent.normalize_logs(store.clone(), &params.workspace_path);
        let persist = spawn_log_persistence_task(
            self.logs_dir.clone(),
            run_id,
            store.clone(),
            self.db.pool().clone(),
            params.executor_session_id,
        );
        let result = self.cloud_turn(&params, &store, &mut cancel).await;
        let code = match &result {
            Ok(code) => *code,
            Err(error) => {
                let message = format!("Cloud execution: {error}");
                store.push(LogEntry::Stderr(message.clone()));
                store.push(cloud_error_entry(agent_kind, &message));
                Some(1)
            }
        };
        for pending in self
            .approvals
            .pending()
            .await
            .into_iter()
            .filter(|approval| approval.task_run_id == run_id)
        {
            let _ = self
                .approvals
                .respond(
                    &pending.approval_id,
                    approvals::ApprovalResponse {
                        status: approvals::ApprovalStatus::TimedOut,
                        answers: None,
                        responded_by: approvals::ApprovalActor::User,
                    },
                )
                .await;
        }
        store.push(LogEntry::Finished);
        let _ = persist.await;
        let _ = events_tx.send(ExecutionEvent::Exit {
            id: run_id,
            code,
            signal: None,
        });
        self.mark_run_completion(run_id, code).await?;
        self.drop_execution_registry(run_id).await;
        self.notify_run_finished(run_id).await;
        result.map(|_| ()).map_err(ContainerError::from)
    }

    async fn cloud_turn(
        &self,
        params: &ExecutionStartParams,
        store: &Arc<MsgStore>,
        cancel: &mut oneshot::Receiver<()>,
    ) -> anyhow::Result<Option<i32>> {
        let client = CloudClient::connect().await?;
        let run = TaskRun::get(self.db.pool(), params.task_run_id).await?;
        self.record_run_start_commit(run.id, &params.workspace_path)
            .await;
        store.push(LogEntry::Stderr("Preparing cloud environment…".into()));
        let session_id = run.task_id.to_string();
        let instance = tokio::select! {
            value = client.instance(&session_id) => value?,
            _ = &mut *cancel => return Ok(None),
        };
        sqlx::query("UPDATE session_execution_locations SET instance_id = ?, endpoint = ? WHERE task_id = ?")
            .bind(&instance.id).bind(&instance.endpoint).bind(run.task_id).execute(self.db.pool()).await?;
        let base = &instance.endpoint;
        // A bundle holds Git objects and refs only: no local CLI credentials,
        // credential helpers, remotes, hooks, or repository config are copied.
        let bytes = cloud::repository_bundle(&params.workspace_path).await?;
        client
            .upload(
                base,
                &format!("/rpc/cloud/repositories/{}", run.task_id),
                bytes,
            )
            .await?;
        let profile = self.resolve_executor_profile_for_run(run.id).await?;
        let started: Value = client.json(base, Method::POST, &format!("/rpc/cloud/repositories/{}/start", run.task_id), Some(json!({
            "prompt": params.prompt, "executor_profile_id": profile, "resume_session_id": params.resume_session_id,
        }))).await?;
        let remote_id = started["run_id"]
            .as_str()
            .ok_or_else(|| anyhow!("Cloud server returned no run id"))?;
        let remote_id = Uuid::parse_str(remote_id)?;
        sqlx::query("UPDATE task_runs SET executor_job_id = ? WHERE id = ?")
            .bind(remote_id.to_string())
            .bind(run.id)
            .execute(self.db.pool())
            .await?;
        store.push(LogEntry::Stderr("Agent is running in Cloud.".into()));
        let mut cursor = 0;
        let mut pending = HashSet::new();
        loop {
            let snapshot_path = format!("/rpc/cloud/runs/{remote_id}/snapshot?cursor={cursor}");
            let snapshot: Snapshot = tokio::select! {
                _ = &mut *cancel => {
                    client.request(base, Method::POST, &format!("/rpc/task-runs/{remote_id}/cancel"), Some(json!({}))).await?;
                    return Ok(None);
                }
                result = client.json(base, Method::GET, &snapshot_path, None) => result?,
            };
            for entry in &snapshot.logs {
                if !matches!(entry, LogEntry::Finished) {
                    store.push(entry.clone());
                }
            }
            cursor = snapshot.log_cursor;
            for approval in snapshot.approvals {
                if !pending.insert(approval.approval_id.clone()) {
                    continue;
                }
                let detail: Value = client
                    .json(
                        base,
                        Method::GET,
                        &format!("/rpc/approvals/{}", approval.approval_id),
                        None,
                    )
                    .await?;
                let mut request: approvals::ApprovalRequest =
                    serde_json::from_value(detail["request"].clone())?;
                let is_question = request.tool_input.get("questions").is_some();
                request.task_run_id = run.id;
                let (local_request, waiter) = self.approvals.forward_with_waiter(request).await?;
                if is_question {
                    TaskRecord::set_awaiting_input(self.db.pool(), run.task_id, true).await?;
                }
                if let Some(hook) = self.approval_pending_hook.read().await.clone() {
                    hook(run.id, local_request.id, approval.tool_name.clone());
                }
                let client = client.clone();
                let base = base.clone();
                let task_id = run.task_id;
                let db = self.db.clone();
                let logs = store.clone();
                tokio::spawn(async move {
                    if let Ok(answer) = waiter.await {
                        if is_question {
                            let _ = TaskRecord::set_awaiting_input(db.pool(), task_id, false).await;
                        }
                        let body = json!({"status": answer.status, "answers": answer.answers, "responded_by": {"kind": "user"}});
                        if let Err(error) = client
                            .request(
                                &base,
                                Method::POST,
                                &format!("/rpc/approvals/{}/respond", approval.approval_id),
                                Some(body),
                            )
                            .await
                        {
                            logs.push(LogEntry::Stderr(format!("Could not deliver cloud approval: {error}. Sign in again and retry the turn.")));
                            warn!(%error, "Could not deliver cloud approval");
                        }
                    }
                });
            }
            if snapshot.settled
                && matches!(
                    snapshot.status,
                    RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled
                )
            {
                // Fetch even on failure: committed partial work remains reviewable.
                let bytes = client
                    .request(
                        base,
                        Method::GET,
                        &format!("/rpc/cloud/runs/{remote_id}/bundle"),
                        None,
                    )
                    .await?
                    .bytes()
                    .await?;
                cloud::import_bundle(&params.workspace_path, &bytes).await?;
                let head = cloud::git(&params.workspace_path, &["rev-parse", "HEAD"]).await?;
                sqlx::query("UPDATE task_runs SET after_head_commit = ? WHERE id = ?")
                    .bind(&head)
                    .bind(run.id)
                    .execute(self.db.pool())
                    .await?;
                self.settle_home_dir(run.task_id, &params.workspace_path, &head)
                    .await;
                store.push(LogEntry::Stderr(
                    "Cloud result imported into this session’s branch.".into(),
                ));
                return Ok(match snapshot.status {
                    RunStatus::Completed => Some(0),
                    RunStatus::Cancelled => None,
                    _ => Some(1),
                });
            }
            tokio::select! { _ = tokio::time::sleep(Duration::from_millis(300)) => {}, _ = &mut *cancel => {
                client.request(base, Method::POST, &format!("/rpc/task-runs/{remote_id}/cancel"), Some(json!({}))).await?;
                return Ok(None);
            } }
        }
    }
}

impl LocalContainerService {
    pub(super) async fn cloud_diff_stream(
        &self,
        run_id: Uuid,
        stats_only: bool,
    ) -> Result<BoxStream<'static, Result<LogEntry, std::io::Error>>, ContainerError> {
        let client = CloudClient::connect().await?;
        let output = stream::unfold(
            (client, self.db.pool().clone(), false),
            move |(client, pool, done)| async move {
                if done {
                    return None;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                let mapping = sqlx::query_as::<_, (Option<String>, Option<String>)>("SELECT r.executor_job_id, l.endpoint FROM task_runs r JOIN session_execution_locations l ON l.task_id = r.task_id WHERE r.id = ?")
                    .bind(run_id).fetch_optional(&pool).await;
                let (remote_id, endpoint) = match mapping {
                    Ok(Some((Some(remote_id), Some(endpoint)))) => (remote_id, endpoint),
                    Ok(_) => {
                        let terminal: Option<RunStatus> = sqlx::query_scalar("SELECT status FROM task_runs WHERE id = ?").bind(run_id).fetch_optional(&pool).await.ok().flatten();
                        let done = matches!(terminal, None | Some(RunStatus::Failed | RunStatus::Cancelled | RunStatus::Completed));
                        let entries = if done { vec![Ok(diff_stream::snapshot_complete()), Ok(LogEntry::Finished)] } else { vec![Ok(diff_stream::snapshot_complete())] };
                        return Some((stream::iter(entries), (client, pool, done)));
                    }
                    Err(error) => return Some((stream::iter(vec![Err(std::io::Error::other(error.to_string()))]), (client, pool, true))),
                };
                let result = client
                    .json::<Value>(
                        &endpoint,
                        Method::GET,
                        &format!("/rpc/cloud/runs/{remote_id}/diff"),
                        None,
                    )
                    .await;
                let (entries, done) = match result {
                    Ok(value) => {
                        let mut entry = value["entry"].clone();
                        if stats_only {
                            if let Some(diffs) = entry
                                .pointer_mut("/payload/0/value")
                                .and_then(Value::as_object_mut)
                            {
                                for diff in diffs.values_mut() {
                                    if let Some(content) =
                                        diff.get_mut("content").and_then(Value::as_object_mut)
                                    {
                                        content.insert("old_content".into(), Value::Null);
                                        content.insert("new_content".into(), Value::Null);
                                        content.insert("content_omitted".into(), Value::Bool(true));
                                    }
                                }
                            }
                        }
                        let done = value["settled"].as_bool().unwrap_or(false);
                        let entry: LogEntry =
                            serde_json::from_value(entry).unwrap_or(LogEntry::Finished);
                        let mut entries = vec![Ok(entry), Ok(diff_stream::snapshot_complete())];
                        if done {
                            entries.push(Ok(LogEntry::Finished));
                        }
                        (entries, done)
                    }
                    Err(error) => (vec![Err(std::io::Error::other(error.to_string()))], true),
                };
                Some((stream::iter(entries), (client, pool, done)))
            },
        )
        .flatten()
        .boxed();
        Ok(output)
    }
}

/// Infrastructure failures must enter the same persisted raw protocol as CLI
/// failures, so both live normalization and replay display the explanation.
fn cloud_error_entry(kind: BaseCodingAgent, message: &str) -> LogEntry {
    let raw = match kind {
        BaseCodingAgent::Codex => {
            executors::executors::codex::normalize_logs::Error::launch_error(message.to_string())
                .raw()
        }
        BaseCodingAgent::Pi => {
            executors::executors::pi::normalize_logs::PiError::launch_error(message.to_string())
                .raw()
        }
        BaseCodingAgent::ClaudeCode => {
            json!({"type": "result", "is_error": true, "error": message}).to_string()
        }
    };
    LogEntry::Stdout(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cloud_failures_remain_visible_after_transcript_replay() {
        let agents = [
            (
                BaseCodingAgent::Codex,
                CodingAgent::Codex(serde_json::from_value(json!({})).unwrap()),
            ),
            (BaseCodingAgent::ClaudeCode, CodingAgent::default()),
            (
                BaseCodingAgent::Pi,
                CodingAgent::Pi(executors::executors::pi::Pi::default()),
            ),
        ];
        for (kind, agent) in agents {
            let entries = [
                cloud_error_entry(kind, "Cloud sign-in expired. Sign in again."),
                LogEntry::Finished,
            ];
            let replay = agent.replay_log_entries(&entries, Path::new("."));
            assert!(serde_json::to_string(&replay)
                .unwrap()
                .contains("Cloud sign-in expired"));
        }
    }
}
