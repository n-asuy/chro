use crate::error::{ApiError, ApiResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use worker::{wasm_bindgen::JsValue, D1Database};

/// Upper bound on stored message length to keep a single row well within D1
/// limits and to blunt abusive payloads. Messages are truncated, not rejected.
const MESSAGE_MAX_LEN: usize = 5000;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackCategory {
    #[default]
    Feedback,
    Bug,
    Feature,
}

impl FeedbackCategory {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Feedback => "feedback",
            Self::Bug => "bug",
            Self::Feature => "feature",
        }
    }

    /// Human-facing label used in the Slack notification.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Feedback => "feedback",
            Self::Bug => "bug report",
            Self::Feature => "feature request",
        }
    }

    fn from_db(value: &str) -> Self {
        match value {
            "bug" => Self::Bug,
            "feature" => Self::Feature,
            _ => Self::Feedback,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackInput {
    #[serde(default)]
    pub category: FeedbackCategory,
    pub message: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackRecord {
    pub id: String,
    pub category: FeedbackCategory,
    pub message: String,
    pub created_at: String,
}

/// The persisted record plus the extra context needed to build a notification,
/// so callers do not have to re-normalize the raw input.
pub struct StoredFeedback {
    pub record: FeedbackRecord,
    pub email: Option<String>,
    pub name: Option<String>,
    pub app_version: Option<String>,
    pub platform: Option<String>,
}

#[derive(Deserialize)]
struct FeedbackRow {
    id: String,
    category: String,
    message: String,
    created_at: String,
}

pub async fn store_feedback(
    db: &D1Database,
    input: FeedbackInput,
    user_agent: Option<&str>,
) -> ApiResult<StoredFeedback> {
    let message = normalize_message(&input.message)?;
    let email = normalize_optional(input.email);
    let name = normalize_optional(input.name);
    let user_id = normalize_optional(input.user_id);
    let app_version = normalize_optional(input.app_version);
    let platform = normalize_optional(input.platform);
    let user_agent = normalize_optional(user_agent.map(str::to_string));
    let id = Uuid::new_v4().to_string();

    let stmt = db.prepare(
        "INSERT INTO feedback (id, category, message, email, name, user_id, app_version, platform, user_agent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         RETURNING id, category, message, created_at",
    );

    let row = stmt
        .bind(&[
            JsValue::from_str(&id),
            JsValue::from_str(input.category.as_str()),
            JsValue::from_str(&message),
            bind_text(email.as_deref()),
            bind_text(name.as_deref()),
            bind_text(user_id.as_deref()),
            bind_text(app_version.as_deref()),
            bind_text(platform.as_deref()),
            bind_text(user_agent.as_deref()),
        ])?
        .first::<FeedbackRow>(None)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to store feedback"))?;

    Ok(StoredFeedback {
        record: FeedbackRecord {
            id: row.id,
            category: FeedbackCategory::from_db(&row.category),
            message: row.message,
            created_at: row.created_at,
        },
        email,
        name,
        app_version,
        platform,
    })
}

fn normalize_message(input: &str) -> ApiResult<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request("Feedback message must not be empty"));
    }
    Ok(trimmed.chars().take(MESSAGE_MAX_LEN).collect())
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn bind_text(value: Option<&str>) -> JsValue {
    match value {
        Some(text) => JsValue::from_str(text),
        None => JsValue::NULL,
    }
}
