use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;
use tokio::sync::{mpsc, Semaphore};
use tokio::task::JoinError;

static PERF_TX: OnceLock<mpsc::Sender<String>> = OnceLock::new();

/// Upper bound on git blocking operations running at once via a
/// bounded-concurrency runner: even though each op is now timeout-bounded and
/// fast, a burst of polling across many sessions (status/diff/branch-status for
/// every visible run) should not spawn dozens of git subprocesses
/// simultaneously and contend on the same worktrees and disk. Excess ops queue
/// briefly for a permit rather than piling onto the blocking pool.
const GIT_BLOCKING_LIMIT: usize = 16;

static GIT_BLOCKING_SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();

fn git_blocking_semaphore() -> &'static Semaphore {
    GIT_BLOCKING_SEMAPHORE.get_or_init(|| Semaphore::new(GIT_BLOCKING_LIMIT))
}

/// Blocking tasks submitted via [`spawn_blocking_instrumented`] that have been
/// queued but not yet finished. A value climbing toward tokio's blocking-pool
/// limit (512 by default) while `queue_wait_ms` rises is the signature of a
/// saturated pool — the suspected cause of the server-wide stalls where many
/// unrelated endpoints slow down together.
static BLOCKING_INFLIGHT: AtomicI64 = AtomicI64::new(0);

fn elapsed_ms(since: Instant) -> f64 {
    let ms = (since.elapsed().as_micros() as f64) / 1000.0;
    (ms * 100.0).round() / 100.0
}

/// Register the perf log sender. Called once at startup by the server crate.
pub fn register_sender(tx: mpsc::Sender<String>) {
    let _ = PERF_TX.set(tx);
}

fn timestamp() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Record a backend perf event from any crate that depends on `runtime`.
pub fn record_event(name: &str, fields: serde_json::Value) {
    let Some(tx) = PERF_TX.get() else {
        return;
    };

    let mut payload = serde_json::Map::new();
    payload.insert("ts".into(), serde_json::Value::String(timestamp()));
    payload.insert(
        "type".into(),
        serde_json::Value::String("backend-action".into()),
    );
    payload.insert("name".into(), serde_json::Value::String(name.into()));

    if let serde_json::Value::Object(fields) = fields {
        for (key, value) in fields {
            payload.insert(key, value);
        }
    }

    let line = serde_json::Value::Object(payload).to_string();
    // Best-effort send; if channel is full we drop the event.
    let _ = tx.try_send(line);
}

/// Run `f` on the blocking pool, recording how long it waited for a pool thread
/// (`queue_wait_ms`) versus how long the work itself took (`work_ms`), plus the
/// in-flight blocking depth at submit time. This separates "the blocking pool is
/// saturated" (high `queue_wait_ms` with `inflight_at_submit` near the pool
/// limit) from "the operation itself is slow" (high `work_ms`, e.g. git lock
/// contention on a large worktree). The timing is unconditional and ~free; the
/// event is only written when perf recording is enabled.
pub async fn spawn_blocking_instrumented<F, T>(
    label: &'static str,
    f: F,
) -> Result<T, JoinError>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    // Bound how many git blocking ops run at once. Acquired before
    // timing so `queue_wait_ms` still measures only the blocking-pool queue, not
    // this admission wait. Held until the op completes.
    let _permit = git_blocking_semaphore()
        .acquire()
        .await
        .expect("git blocking semaphore is never closed");

    let queued_at = Instant::now();
    let inflight_at_submit = BLOCKING_INFLIGHT.fetch_add(1, Ordering::Relaxed) + 1;
    let result = tokio::task::spawn_blocking(move || {
        let queue_wait_ms = elapsed_ms(queued_at);
        let started = Instant::now();
        let out = f();
        BLOCKING_INFLIGHT.fetch_sub(1, Ordering::Relaxed);
        record_event(
            "blocking_task",
            serde_json::json!({
                "label": label,
                "queue_wait_ms": queue_wait_ms,
                "work_ms": elapsed_ms(started),
                "inflight_at_submit": inflight_at_submit,
            }),
        );
        out
    })
    .await;
    // If the join failed (panic/cancel) the closure never decremented.
    if result.is_err() {
        BLOCKING_INFLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
    result
}
