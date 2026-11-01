//! Projects: the repositories and folders sessions run in.

use std::path::PathBuf;

use axum::{
    extract::{Path, State},
    Json,
};
use db::models::ProjectRecord;
use server_contract::api::{EnsureProject, ProjectList, ProjectView};

use super::{selectors, views::project_view, V1Result, V1};
use crate::AppState;

pub(crate) async fn list(State(state): State<AppState>) -> V1Result<ProjectList> {
    let chats = config::chats_dir();
    let projects = ProjectRecord::list_all(state.pool())
        .await?
        .iter()
        // The hidden project behind scratch chats is not something to address.
        .filter(|project| std::path::Path::new(&project.git_repo_path) != chats)
        .map(project_view)
        .collect();
    Ok(V1(ProjectList { projects }))
}

pub(crate) async fn show(
    State(state): State<AppState>,
    Path(selector): Path<String>,
) -> V1Result<ProjectView> {
    let project = selectors::project(state.pool(), &selector).await?;
    Ok(V1(project_view(&project)))
}

pub(crate) async fn ensure(
    State(state): State<AppState>,
    Json(body): Json<EnsureProject>,
) -> V1Result<ProjectView> {
    let project = selectors::project_ensuring(state.pool(), &format!("path:{}", body.path)).await?;
    state.spawn_index_prewarm(PathBuf::from(&project.git_repo_path));
    Ok(V1(project_view(&project)))
}
