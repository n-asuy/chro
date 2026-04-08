use db::models::{ProjectRecord, TaskRecord, TaskRun};
use sqlx::{Pool, Sqlite};
use uuid::Uuid;

use crate::ApiError;

/// Parse a string as UUID, or resolve it as a slug for the given entity.
/// Provides a single entry point so every route handler uses the same logic.

pub(crate) async fn resolve_project(
    pool: &Pool<Sqlite>,
    identifier: &str,
) -> Result<ProjectRecord, ApiError> {
    Ok(ProjectRecord::get_by_identifier(pool, identifier).await?)
}

pub(crate) async fn resolve_project_id(
    pool: &Pool<Sqlite>,
    identifier: &str,
) -> Result<Uuid, ApiError> {
    Ok(resolve_project(pool, identifier).await?.id)
}

pub(crate) async fn resolve_task(
    pool: &Pool<Sqlite>,
    identifier: &str,
) -> Result<TaskRecord, ApiError> {
    Ok(TaskRecord::get_by_identifier(pool, identifier).await?)
}

pub(crate) async fn resolve_task_id(
    pool: &Pool<Sqlite>,
    identifier: &str,
) -> Result<Uuid, ApiError> {
    Ok(resolve_task(pool, identifier).await?.id)
}

pub(crate) async fn resolve_task_run(
    pool: &Pool<Sqlite>,
    identifier: &str,
) -> Result<TaskRun, ApiError> {
    Ok(TaskRun::get_by_identifier(pool, identifier).await?)
}

pub(crate) async fn resolve_task_run_id(
    pool: &Pool<Sqlite>,
    identifier: &str,
) -> Result<Uuid, ApiError> {
    Ok(resolve_task_run(pool, identifier).await?.id)
}
