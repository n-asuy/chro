//! A real server state on a throwaway database, for tests that go through
//! the router.

use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

use db::models::{ProjectRecord, TaskRecord};
use local_runtime::LocalRuntime;
use runtime::{Runtime, RuntimeOptions};
use tempfile::TempDir;
use uuid::Uuid;

use crate::{operator, runtime_identity::RuntimeIdentity, AppState};

pub(crate) struct TestApp {
    pub state: AppState,
    pub dir: TempDir,
}

/// Point the runtime's config and per-user directories (the image cache
/// lives under the home directory) at a directory of their own, once per test
/// process, so tests never read or write the user's settings, caches or
/// sessions.
fn isolate_config() {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        let home = tempfile::tempdir().expect("test home").keep();
        std::env::set_var("CHRO_CONFIG_PATH", home.join("config.json"));
        std::env::set_var("HOME", &home);
        // A test run inside a chro session inherits that session's server;
        // the runtime under test must not adopt (and sweep) its processes.
        std::env::remove_var(crate::runtime_identity::RUNTIME_FILE_ENV);
        std::env::remove_var("CHRO_SESSION_TOKEN");
        // Agent config files resolve from these before the home directory;
        // tests that save MCP settings must never reach the user's.
        for agent_config in [
            "CLAUDE_CONFIG_PATH",
            "CODEX_CONFIG_PATH",
            "PI_CODING_AGENT_DIR",
        ] {
            std::env::remove_var(agent_config);
        }
        home
    });
}

/// Held by tests that read or write the agents' MCP config files, which every
/// test of the process shares under the isolated home directory.
pub(crate) async fn agent_config_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    LOCK.lock().await
}

/// The isolated home directory's Claude Code config file.
pub(crate) fn claude_config_file() -> PathBuf {
    isolate_config();
    dirs::home_dir()
        .expect("isolated home")
        .join(".claude.json")
}

pub(crate) async fn app() -> TestApp {
    isolate_config();
    let dir = tempfile::tempdir().expect("test dir");
    let db_path = dir.path().join("chro.sqlite");
    let runtime = LocalRuntime::bootstrap(RuntimeOptions {
        user_id: "test".to_string(),
        db_path: Some(db_path.clone()),
    })
    .await
    .expect("runtime boots");
    let identity = RuntimeIdentity::new(&db_path, "http://127.0.0.1:0".to_string());
    operator::set_identity(&identity);
    TestApp {
        state: AppState::new(runtime, identity),
        dir,
    }
}

impl TestApp {
    /// A git repository with one commit, registered as a project.
    pub(crate) async fn project(&self, name: &str) -> ProjectRecord {
        let repo = self.dir.path().join(name);
        init_repo(&repo);
        ProjectRecord::ensure_with_name_hint(self.state.pool(), &repo.to_string_lossy(), None)
            .await
            .expect("project")
    }

    pub(crate) async fn task(&self, project: &ProjectRecord, title: &str) -> TaskRecord {
        let task = TaskRecord::new(project.id, title, None);
        task.insert(self.state.pool()).await.expect("task");
        task
    }

    pub(crate) fn pool(&self) -> &sqlx::SqlitePool {
        self.state.runtime().db().pool()
    }
}

fn init_repo(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    std::fs::write(path.join("README.md"), "# fixture\n").unwrap();
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(path)
            .env("GIT_AUTHOR_NAME", "chro")
            .env("GIT_AUTHOR_EMAIL", "chro@example.invalid")
            .env("GIT_COMMITTER_NAME", "chro")
            .env("GIT_COMMITTER_EMAIL", "chro@example.invalid")
            .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z")
            .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")
            .output()
            .expect("git runs");
        assert!(status.status.success(), "git {args:?}: {status:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["add", "README.md"]);
    git(&["commit", "-q", "-m", "fixture"]);
}

/// An id no row has.
pub(crate) fn missing_id() -> String {
    Uuid::new_v4().to_string()
}
