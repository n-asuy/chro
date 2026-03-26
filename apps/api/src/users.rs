use crate::auth::AuthenticatedUser;
use crate::error::{ApiError, ApiResult};
use serde::Deserialize;
use worker::{wasm_bindgen::JsValue, D1Database};

#[derive(Deserialize)]
struct LoginCountRow {
    login_count: i64,
}

pub async fn upsert_user_and_get_login_count(
    db: &D1Database,
    user: &AuthenticatedUser,
) -> ApiResult<i64> {
    let stmt = db.prepare(
        "INSERT INTO users (id, email, name, login_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, datetime('now'), datetime('now'))
         ON CONFLICT (id) DO UPDATE SET
           email = excluded.email,
           name = excluded.name,
           login_count = login_count + 1,
           updated_at = datetime('now')
         RETURNING login_count",
    );

    let row = stmt
        .bind(&[
            JsValue::from_str(&user.id),
            match &user.email {
                Some(email) => JsValue::from_str(email),
                None => JsValue::NULL,
            },
            match &user.name {
                Some(name) => JsValue::from_str(name),
                None => JsValue::NULL,
            },
        ])?
        .first::<LoginCountRow>(None)
        .await
        .map_err(ApiError::from)?;

    Ok(row.map(|r| r.login_count).unwrap_or(1))
}
