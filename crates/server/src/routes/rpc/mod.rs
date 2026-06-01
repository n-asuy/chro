//! RPC route modules split by domain.
//!
//! This module organizes API endpoints by their domain/feature:
//! - `projects`: Project management
//! - `tasks`: Task CRUD and status updates
//! - `task_runs`: Task execution runs, logs, merges
//! - `sessions`: Executor sessions
//! - `workspace`: File system operations
//! - `approvals`: Approval workflow
//! - `config`: Preferences and executor configuration
//! - `events`: Global event triggers
//! - `developer`: Developer tools (worktree management)
//! - `images`: Image upload/serve (merged from api.rs)
//! - `merges`: Merge record management (merged from api.rs)

mod approvals;
mod config;
mod context_refs;
mod developer;
mod events;
mod filesystem;
mod git;
mod images;
mod merges;
mod path_resolve;
mod projects;
mod sessions;
mod skills;
mod task_runs;
mod tasks;
mod workspace;

use axum::Router;

use crate::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .merge(projects::router())
        .merge(tasks::router())
        .merge(task_runs::router())
        .merge(sessions::router())
        .merge(skills::router())
        .merge(workspace::router())
        .merge(approvals::router())
        .merge(config::router())
        .merge(events::router())
        .merge(developer::router())
        .merge(images::router())
        .merge(merges::router())
        .merge(git::router())
        .merge(filesystem::router())
}

pub(crate) fn sessions_router() -> Router<AppState> {
    sessions::sessions_by_workspace_router()
}

pub(crate) use images::{process_image_upload, ImageEnvelope};
