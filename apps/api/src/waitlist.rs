use crate::error::{ApiError, ApiResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use worker::{wasm_bindgen::JsValue, D1Database};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WaitlistStatus {
    Pending,
    Invited,
    Joined,
}

impl WaitlistStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Invited => "invited",
            Self::Joined => "joined",
        }
    }

    fn from_db(value: &str) -> Self {
        match value.to_ascii_lowercase().as_str() {
            "invited" => Self::Invited,
            "joined" => Self::Joined,
            _ => Self::Pending,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistInput {
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub use_case: Option<String>,
    #[serde(default)]
    pub invite_code: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistUpdateInput {
    pub status: WaitlistStatus,
    #[serde(default)]
    pub invite_code: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistEntry {
    pub id: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_case: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_code: Option<String>,
    pub status: WaitlistStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistSummary {
    pub total: i64,
    pub pending: i64,
    pub invited: i64,
    pub joined: i64,
}

#[derive(Deserialize)]
struct WaitlistRow {
    id: String,
    email: String,
    name: Option<String>,
    use_case: Option<String>,
    invite_code: Option<String>,
    status: String,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct SummaryRow {
    status: String,
    total: i64,
}

pub async fn join_waitlist(db: &D1Database, payload: WaitlistInput) -> ApiResult<WaitlistEntry> {
    let email = normalize_email(&payload.email)?;
    let name = normalize_optional(payload.name);
    let use_case = normalize_optional(payload.use_case);
    let invite_code = normalize_optional(payload.invite_code);
    let id = Uuid::new_v4().to_string();

    let stmt = db.prepare(
        "INSERT INTO waitlist_entries (id, email, name, use_case, invite_code, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending')
         ON CONFLICT(email) DO UPDATE SET
            name = COALESCE(excluded.name, waitlist_entries.name),
            use_case = COALESCE(excluded.use_case, waitlist_entries.use_case),
            invite_code = COALESCE(excluded.invite_code, waitlist_entries.invite_code),
            updated_at = datetime('now')
         RETURNING id, email, name, use_case, invite_code, status, created_at, updated_at",
    );

    let row = stmt
        .bind(&[
            JsValue::from_str(&id),
            JsValue::from_str(&email),
            bind_text(name.as_deref()),
            bind_text(use_case.as_deref()),
            bind_text(invite_code.as_deref()),
        ])?
        .first::<WaitlistRow>(None)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to upsert waitlist entry"))?;

    Ok(map_row(row))
}

pub async fn list_waitlist_entries(db: &D1Database, limit: i32) -> ApiResult<Vec<WaitlistEntry>> {
    let stmt = db.prepare(
        "SELECT id, email, name, use_case, invite_code, status, created_at, updated_at
         FROM waitlist_entries
         ORDER BY created_at DESC
         LIMIT ?1",
    );

    let rows: Vec<WaitlistRow> = stmt
        .bind(&[JsValue::from_f64(limit as f64)])?
        .all()
        .await
        .map_err(ApiError::from)?
        .results()
        .map_err(ApiError::from)?;

    Ok(rows.into_iter().map(map_row).collect())
}

pub async fn update_waitlist_entry(
    db: &D1Database,
    id: &str,
    update: WaitlistUpdateInput,
) -> ApiResult<WaitlistEntry> {
    let mut sql = String::from(
        "UPDATE waitlist_entries
         SET status = ?1, updated_at = datetime('now')",
    );
    let mut params: Vec<JsValue> = vec![JsValue::from_str(update.status.as_str())];

    if let Some(invite_code_raw) = update.invite_code {
        let normalized = normalize_optional(Some(invite_code_raw));
        sql.push_str(", invite_code = ?2 WHERE id = ?3 RETURNING id, email, name, use_case, invite_code, status, created_at, updated_at");
        params.push(bind_text(normalized.as_deref()));
        params.push(JsValue::from_str(id));
    } else {
        sql.push_str(" WHERE id = ?2 RETURNING id, email, name, use_case, invite_code, status, created_at, updated_at");
        params.push(JsValue::from_str(id));
    }

    let stmt = db.prepare(&sql);
    let row = stmt
        .bind(&params)?
        .first::<WaitlistRow>(None)
        .await?
        .ok_or_else(|| ApiError::bad_request("Waitlist entry not found"))?;

    Ok(map_row(row))
}

pub async fn waitlist_summary(db: &D1Database) -> ApiResult<WaitlistSummary> {
    let stmt = db.prepare("SELECT status, COUNT(*) AS total FROM waitlist_entries GROUP BY status");

    let rows: Vec<SummaryRow> = stmt
        .all()
        .await
        .map_err(ApiError::from)?
        .results()
        .map_err(ApiError::from)?;

    let mut summary = WaitlistSummary {
        total: 0,
        pending: 0,
        invited: 0,
        joined: 0,
    };

    for row in rows {
        summary.total += row.total;
        match WaitlistStatus::from_db(&row.status) {
            WaitlistStatus::Pending => summary.pending += row.total,
            WaitlistStatus::Invited => summary.invited += row.total,
            WaitlistStatus::Joined => summary.joined += row.total,
        }
    }

    Ok(summary)
}

fn normalize_email(input: &str) -> ApiResult<String> {
    let trimmed = input.trim().to_ascii_lowercase();
    if trimmed.is_empty() || !trimmed.contains('@') {
        return Err(ApiError::bad_request("A valid email address is required"));
    }
    Ok(trimmed)
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

fn map_row(row: WaitlistRow) -> WaitlistEntry {
    WaitlistEntry {
        id: row.id,
        email: row.email,
        name: row.name,
        use_case: row.use_case,
        invite_code: row.invite_code,
        status: WaitlistStatus::from_db(&row.status),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}
