mod auth;
mod error;
mod feedback;
mod invites;
mod slack;
mod users;
mod waitlist;

use auth::{require_admin_secret, require_user, AuthenticatedUser};
use error::{ApiError, ApiResult};
use feedback::{store_feedback, FeedbackInput};
use invites::{
    claim_invite_code, create_invite_code, list_invite_codes, verify_invite_code,
    CreateInviteCodeInput, InviteCodeRecord,
};
use serde::Serialize;
use slack::{FeedbackInfo, LoginInfo};
use users::upsert_user_and_get_login_count;
use waitlist::{
    join_waitlist, list_waitlist_entries, update_waitlist_entry, waitlist_summary, WaitlistEntry,
    WaitlistInput, WaitlistUpdateInput,
};
use worker::{
    console_log, event, Context, D1Database, Env, Request, Response, Result, RouteContext, Router,
};

const WAITLIST_DEFAULT_LIMIT: u32 = 100;
const WAITLIST_MAX_LIMIT: u32 = 500;

struct SyncedUser {
    user: AuthenticatedUser,
    login_count: i64,
}

async fn require_user_with_sync(
    req: &Request,
    ctx: &RouteContext<()>,
    db: &D1Database,
) -> ApiResult<SyncedUser> {
    let user = require_user(req, ctx).await?;

    let login_count = match upsert_user_and_get_login_count(db, &user).await {
        Ok(count) => count,
        Err(err) => {
            console_log!("[users] Failed to upsert user {}: {:?}", user.id, err);
            1
        }
    };

    Ok(SyncedUser { user, login_count })
}

#[event(fetch, respond_with_errors)]
pub async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    if req.method() == worker::Method::Options {
        return cors_preflight();
    }

    let response = Router::new()
        .get_async("/health", |_req, _ctx| async { Response::ok("ok") })
        .get_async("/session", |req, ctx| async move {
            handle_session(req, ctx).await
        })
        .post_async("/waitlist", |mut req, ctx| async move {
            handle_join_waitlist(&mut req, ctx).await
        })
        .post_async("/feedback", |mut req, ctx| async move {
            handle_submit_feedback(&mut req, ctx).await
        })
        .get_async("/waitlist", |req, ctx| async move {
            handle_list_waitlist(req, ctx).await
        })
        .put_async("/waitlist/:id/status", |mut req, ctx| async move {
            handle_update_waitlist(&mut req, ctx).await
        })
        .get_async("/waitlist/summary", |req, ctx| async move {
            handle_waitlist_summary(req, ctx).await
        })
        .get_async("/invite-codes", |req, ctx| async move {
            handle_list_invite_codes(req, ctx).await
        })
        .post_async("/invite-codes", |mut req, ctx| async move {
            handle_create_invite_code(&mut req, ctx).await
        })
        .post_async("/internal/invite-codes", |mut req, ctx| async move {
            handle_admin_create_invite_code(&mut req, ctx).await
        })
        .get_async("/invite-codes/:code/verify", |req, ctx| async move {
            handle_verify_invite_code(req, ctx).await
        })
        .post_async("/invite-codes/:code/claim", |req, ctx| async move {
            handle_claim_invite_code(req, ctx).await
        })
        .run(req, env)
        .await?;

    add_cors_headers(response)
}

async fn handle_session(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("APP_DB")?;
    let synced = match require_user_with_sync(&req, &ctx, &db).await {
        Ok(synced) => synced,
        Err(err) => return err.into_response(),
    };

    if let Ok(webhook_url) = ctx.env.secret("SLACK_WEBHOOK_URL") {
        let user_agent = req.headers().get("User-Agent").ok().flatten();

        let info = LoginInfo {
            user_id: &synced.user.id,
            email: synced.user.email.as_deref(),
            name: synced.user.name.as_deref(),
            user_agent: user_agent.as_deref(),
            is_first_login: synced.login_count == 1,
        };

        slack::notify_login(&webhook_url.to_string(), &info).await;
    }

    #[derive(Serialize)]
    struct SessionPayload {
        user_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        email: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    }

    json_response(&SessionPayload {
        user_id: synced.user.id,
        email: synced.user.email,
        name: synced.user.name,
    })
}

async fn handle_submit_feedback(req: &mut Request, ctx: RouteContext<()>) -> Result<Response> {
    let payload: FeedbackInput = match req.json().await {
        Ok(body) => body,
        Err(err) => return bad_request(format!("invalid JSON: {}", err)),
    };

    let user_agent = req.headers().get("User-Agent").ok().flatten();

    let db = ctx.env.d1("APP_DB")?;
    let stored = match store_feedback(&db, payload, user_agent.as_deref()).await {
        Ok(stored) => stored,
        Err(err) => return err.into_response(),
    };

    if let Ok(webhook_url) = ctx.env.secret("SLACK_WEBHOOK_URL") {
        let info = FeedbackInfo {
            category: stored.record.category.label(),
            message: &stored.record.message,
            email: stored.email.as_deref(),
            name: stored.name.as_deref(),
            app_version: stored.app_version.as_deref(),
            platform: stored.platform.as_deref(),
        };
        slack::notify_feedback(&webhook_url.to_string(), &info).await;
    }

    json_response(&stored.record)
}

async fn handle_join_waitlist(req: &mut Request, ctx: RouteContext<()>) -> Result<Response> {
    let payload: WaitlistInput = match req.json().await {
        Ok(body) => body,
        Err(err) => return bad_request(format!("invalid JSON: {}", err)),
    };

    let db = ctx.env.d1("APP_DB")?;
    match join_waitlist(&db, payload).await {
        Ok(entry) => json_response(&entry),
        Err(err) => err.into_response(),
    }
}

async fn handle_list_waitlist(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("APP_DB")?;
    let _ = match require_user_with_sync(&req, &ctx, &db).await {
        Ok(synced) => synced,
        Err(err) => return err.into_response(),
    };

    let limit = extract_limit(&req, WAITLIST_DEFAULT_LIMIT, WAITLIST_MAX_LIMIT) as i32;

    #[derive(Serialize)]
    struct WaitlistResponse {
        entries: Vec<WaitlistEntry>,
    }

    match list_waitlist_entries(&db, limit).await {
        Ok(entries) => json_response(&WaitlistResponse { entries }),
        Err(err) => err.into_response(),
    }
}

async fn handle_update_waitlist(req: &mut Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("APP_DB")?;
    let _ = match require_user_with_sync(req, &ctx, &db).await {
        Ok(synced) => synced,
        Err(err) => return err.into_response(),
    };

    let entry_id = match ctx.param("id") {
        Some(value) => value.to_string(),
        None => return ApiError::bad_request("Missing waitlist entry id").into_response(),
    };

    let payload: WaitlistUpdateInput = match req.json().await {
        Ok(body) => body,
        Err(err) => return bad_request(format!("invalid JSON: {}", err)),
    };
    match update_waitlist_entry(&db, &entry_id, payload).await {
        Ok(entry) => json_response(&entry),
        Err(err) => err.into_response(),
    }
}

async fn handle_waitlist_summary(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("APP_DB")?;
    let _ = match require_user_with_sync(&req, &ctx, &db).await {
        Ok(synced) => synced,
        Err(err) => return err.into_response(),
    };
    match waitlist_summary(&db).await {
        Ok(summary) => json_response(&summary),
        Err(err) => err.into_response(),
    }
}

async fn handle_list_invite_codes(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("APP_DB")?;
    let _ = match require_user_with_sync(&req, &ctx, &db).await {
        Ok(synced) => synced,
        Err(err) => return err.into_response(),
    };
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct InviteResponse {
        invite_codes: Vec<InviteCodeRecord>,
    }

    match list_invite_codes(&db).await {
        Ok(invites) => json_response(&InviteResponse {
            invite_codes: invites,
        }),
        Err(err) => err.into_response(),
    }
}

async fn handle_create_invite_code(req: &mut Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("APP_DB")?;
    let synced = match require_user_with_sync(req, &ctx, &db).await {
        Ok(synced) => synced,
        Err(err) => return err.into_response(),
    };

    handle_invite_code_creation(req, &db, synced.user).await
}

async fn handle_admin_create_invite_code(
    req: &mut Request,
    ctx: RouteContext<()>,
) -> Result<Response> {
    let user = match require_admin_secret(req, &ctx) {
        Ok(user) => user,
        Err(err) => return err.into_response(),
    };

    let db = ctx.env.d1("APP_DB")?;
    handle_invite_code_creation(req, &db, user).await
}

async fn handle_invite_code_creation(
    req: &mut Request,
    db: &D1Database,
    user: AuthenticatedUser,
) -> Result<Response> {
    let payload: CreateInviteCodeInput = match req.json().await {
        Ok(body) => body,
        Err(err) => return bad_request(format!("invalid JSON: {}", err)),
    };

    match create_invite_code(db, &user, payload).await {
        Ok(record) => json_response(&record),
        Err(err) => err.into_response(),
    }
}

async fn handle_verify_invite_code(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let code = match ctx.param("code") {
        Some(value) => value.to_string(),
        None => return ApiError::bad_request("Missing invite code").into_response(),
    };

    let db = ctx.env.d1("APP_DB")?;
    match verify_invite_code(&db, &code).await {
        Ok(result) => json_response(&result),
        Err(err) => err.into_response(),
    }
}

async fn handle_claim_invite_code(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let code = match ctx.param("code") {
        Some(value) => value.to_string(),
        None => return ApiError::bad_request("Missing invite code").into_response(),
    };

    let db = ctx.env.d1("APP_DB")?;
    match claim_invite_code(&db, &code).await {
        Ok(result) => json_response(&result),
        Err(err) => err.into_response(),
    }
}

fn extract_limit(req: &Request, default: u32, max: u32) -> u32 {
    req.url()
        .ok()
        .and_then(|url| {
            url.query_pairs().find_map(|(key, value)| {
                if key == "limit" {
                    value.parse::<u32>().ok()
                } else {
                    None
                }
            })
        })
        .map(|value| value.clamp(1, max))
        .unwrap_or(default)
}

fn bad_request(message: impl Into<String>) -> Result<Response> {
    let mut response = Response::from_json(&serde_json::json!({ "error": message.into() }))?;
    let headers = response.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
    )?;
    headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
    )?;
    Ok(response.with_status(400))
}

fn json_response<T: Serialize>(payload: &T) -> Result<Response> {
    let mut response = Response::from_json(payload)?;
    let headers = response.headers_mut();
    headers.set("Content-Type", "application/json")?;
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
    )?;
    headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
    )?;
    Ok(response)
}

fn cors_preflight() -> Result<Response> {
    let mut response = Response::empty()?;
    let headers = response.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
    )?;
    headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
    )?;
    headers.set("Access-Control-Max-Age", "86400")?;
    Ok(response.with_status(204))
}

fn add_cors_headers(mut response: Response) -> Result<Response> {
    let headers = response.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
    )?;
    headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
    )?;
    Ok(response)
}
