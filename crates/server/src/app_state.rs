use std::sync::Arc;

use local_runtime::LocalRuntime;
use runtime::Runtime;
use sqlx::{Pool, Sqlite};

use crate::browser_session::BrowserService;
use crate::routes::rpc::cli_status::LatestReleaseCache;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) runtime: LocalRuntime,
    pub(crate) browser: Arc<BrowserService>,
    pub(crate) latest_release_cache: Arc<LatestReleaseCache>,
}

impl AppState {
    pub(crate) fn new(runtime: LocalRuntime) -> Self {
        Self {
            runtime,
            browser: Arc::new(BrowserService::new()),
            latest_release_cache: Arc::new(LatestReleaseCache::new()),
        }
    }

    pub(crate) fn latest_release_cache(&self) -> &Arc<LatestReleaseCache> {
        &self.latest_release_cache
    }

    pub(crate) fn pool(&self) -> &Pool<Sqlite> {
        self.runtime.db().pool()
    }

    pub(crate) fn runtime(&self) -> &LocalRuntime {
        &self.runtime
    }

    pub(crate) fn browser(&self) -> &Arc<BrowserService> {
        &self.browser
    }
}
