//! Skill discovery endpoints.

use std::path::PathBuf;

use axum::{extract::Query, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use skills::{SkillRegistry, SkillSummary};

use crate::{ApiError, AppState};

#[derive(Debug, Deserialize)]
struct ListSkillsQuery {
    workspace_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct SkillsEnvelope {
    skills: Vec<SkillSummary>,
}

pub(super) fn router() -> Router<AppState> {
    Router::new().route("/skills", get(list_skills))
}

async fn list_skills(
    Query(query): Query<ListSkillsQuery>,
) -> Result<Json<SkillsEnvelope>, ApiError> {
    let workspace_path = query
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let skills = SkillRegistry::new()
        .list(workspace_path.as_deref())
        .map_err(|err| ApiError::BadRequest(err.to_string()))?;

    Ok(Json(SkillsEnvelope { skills }))
}
