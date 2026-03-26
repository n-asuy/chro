use local_runtime::LocalRuntime;
use runtime::Runtime;
use sqlx::{Pool, Sqlite};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) runtime: LocalRuntime,
}

impl AppState {
    pub(crate) fn new(runtime: LocalRuntime) -> Self {
        Self { runtime }
    }

    pub(crate) fn pool(&self) -> &Pool<Sqlite> {
        self.runtime.db().pool()
    }

    pub(crate) fn runtime(&self) -> &LocalRuntime {
        &self.runtime
    }
}
