use crate::auth::AuthenticatedUser;
use crate::error::{ApiError, ApiResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use worker::{wasm_bindgen::JsValue, D1Database};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInviteCodeInput {
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub max_uses: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InviteCodeRecord {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub max_uses: i64,
    pub use_count: i64,
    pub remaining_uses: i64,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteClaimResult {
    pub code: String,
    pub remaining_uses: i64,
}

#[derive(Deserialize)]
struct InviteRow {
    code: String,
    note: Option<String>,
    max_uses: i64,
    use_count: i64,
    created_at: String,
    expires_at: Option<String>,
}

#[derive(Deserialize)]
struct InviteSummaryRow {
    max_uses: i64,
    use_count: i64,
}

pub async fn create_invite_code(
    db: &D1Database,
    created_by: &AuthenticatedUser,
    input: CreateInviteCodeInput,
) -> ApiResult<InviteCodeRecord> {
    let max_uses = input.max_uses.unwrap_or(1).clamp(1, 50);
    let note = input.note.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let code = generate_invite_code();

    let stmt = db.prepare(
        "INSERT INTO invite_codes (code, note, max_uses, use_count, created_by, created_by_email, created_by_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, datetime('now'), datetime('now'))
         RETURNING code, note, max_uses, use_count, created_at, expires_at",
    );

    let row = stmt
        .bind(&[
            JsValue::from_str(&code),
            bind_text(note.as_deref()),
            JsValue::from_f64(max_uses as f64),
            JsValue::from_str(&created_by.id),
            bind_text(created_by.email.as_deref()),
            bind_text(created_by.name.as_deref()),
        ])?
        .first::<InviteRow>(None)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to create invite code"))?;

    Ok(map_invite_row(row))
}

pub async fn list_invite_codes(db: &D1Database) -> ApiResult<Vec<InviteCodeRecord>> {
    let stmt = db.prepare(
        "SELECT code, note, max_uses, use_count, created_at, expires_at
         FROM invite_codes
         ORDER BY created_at DESC",
    );

    let rows: Vec<InviteRow> = stmt
        .all()
        .await
        .map_err(ApiError::from)?
        .results()
        .map_err(ApiError::from)?;

    Ok(rows.into_iter().map(map_invite_row).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteVerifyResult {
    pub valid: bool,
    pub code: String,
    pub remaining_uses: i64,
}

pub async fn verify_invite_code(db: &D1Database, code: &str) -> ApiResult<InviteVerifyResult> {
    let normalized_code = normalize_code(code)?;

    let summary_stmt =
        db.prepare("SELECT max_uses, use_count FROM invite_codes WHERE code = ?1 LIMIT 1");
    let summary = summary_stmt
        .bind(&[JsValue::from_str(&normalized_code)])?
        .first::<InviteSummaryRow>(None)
        .await?;

    match summary {
        Some(row) if row.use_count < row.max_uses => Ok(InviteVerifyResult {
            valid: true,
            code: normalized_code,
            remaining_uses: row.max_uses - row.use_count,
        }),
        Some(_) => Err(ApiError::bad_request(
            "Invite code has already been fully used",
        )),
        None => Err(ApiError::bad_request("Invite code not found")),
    }
}

pub async fn claim_invite_code(db: &D1Database, code: &str) -> ApiResult<InviteClaimResult> {
    let normalized_code = normalize_code(code)?;

    let summary_stmt =
        db.prepare("SELECT max_uses, use_count FROM invite_codes WHERE code = ?1 LIMIT 1");
    let summary = summary_stmt
        .bind(&[JsValue::from_str(&normalized_code)])?
        .first::<InviteSummaryRow>(None)
        .await?
        .ok_or_else(|| ApiError::bad_request("Invite code not found"))?;

    if summary.use_count >= summary.max_uses {
        return Err(ApiError::bad_request("Invite code has already been used"));
    }

    let update_stmt = db.prepare(
        "UPDATE invite_codes SET use_count = use_count + 1, updated_at = datetime('now') WHERE code = ?1",
    );
    update_stmt
        .bind(&[JsValue::from_str(&normalized_code)])?
        .run()
        .await
        .map_err(ApiError::from)?;

    let claim_stmt = db.prepare(
        "INSERT INTO invite_claims (id, code, created_at)
         VALUES (?1, ?2, datetime('now'))",
    );
    claim_stmt
        .bind(&[
            JsValue::from_str(&Uuid::new_v4().to_string()),
            JsValue::from_str(&normalized_code),
        ])?
        .run()
        .await
        .map_err(ApiError::from)?;

    let remaining = (summary.max_uses - summary.use_count - 1).max(0);
    Ok(InviteClaimResult {
        code: normalized_code,
        remaining_uses: remaining,
    })
}

fn generate_invite_code() -> String {
    let raw = Uuid::new_v4().to_string().replace('-', "");
    raw.chars()
        .take(10)
        .collect::<String>()
        .to_ascii_uppercase()
}

fn normalize_code(input: &str) -> ApiResult<String> {
    let trimmed = input.trim().to_ascii_uppercase();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request("Invite code is required"));
    }
    Ok(trimmed)
}

fn bind_text(value: Option<&str>) -> JsValue {
    match value {
        Some(text) => JsValue::from_str(text),
        None => JsValue::NULL,
    }
}

fn map_invite_row(row: InviteRow) -> InviteCodeRecord {
    let remaining = (row.max_uses - row.use_count).max(0);
    InviteCodeRecord {
        code: row.code,
        note: row.note,
        max_uses: row.max_uses,
        use_count: row.use_count,
        remaining_uses: remaining,
        created_at: row.created_at,
        expires_at: row.expires_at,
    }
}
