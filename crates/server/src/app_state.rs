use std::sync::Arc;

use local_runtime::LocalRuntime;
use runtime::Runtime;
use sqlx::{Pool, Sqlite};

use crate::browser_session::BrowserService;
use crate::pty::PtyService;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) runtime: LocalRuntime,
    pub(crate) pty: Arc<PtyService>,
    pub(crate) browser: Arc<BrowserService>,
}

impl AppState {
    pub(crate) fn new(runtime: LocalRuntime) -> Self {
        Self {
            runtime,
            pty: Arc::new(PtyService::new()),
            browser: Arc::new(BrowserService::new()),
        }
    }

    pub(crate) fn pool(&self) -> &Pool<Sqlite> {
        self.runtime.db().pool()
    }

    pub(crate) fn runtime(&self) -> &LocalRuntime {
        &self.runtime
    }

    pub(crate) fn pty(&self) -> &Arc<PtyService> {
        &self.pty
    }

    pub(crate) fn browser(&self) -> &Arc<BrowserService> {
        &self.browser
    }
}
