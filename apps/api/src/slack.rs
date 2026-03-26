use serde::Serialize;
use worker::{console_log, Fetch, Headers, Method, Request, RequestInit, Url};

#[derive(Serialize)]
struct SlackMessage {
    text: String,
}

pub struct LoginInfo<'a> {
    pub user_id: &'a str,
    pub email: Option<&'a str>,
    pub name: Option<&'a str>,
    pub user_agent: Option<&'a str>,
    pub is_first_login: bool,
}

pub async fn notify_login(webhook_url: &str, info: &LoginInfo<'_>) {
    if !info.is_first_login {
        return;
    }

    let display_name = info
        .name
        .or(info.email)
        .map(|s| s.to_string())
        .unwrap_or_else(|| info.user_id.to_string());

    let mut lines = vec![format!("User signed up: {}", display_name)];

    lines.push(format!(
        "Time: {}",
        chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC")
    ));

    if let Some(ua) = info.user_agent {
        let browser = parse_user_agent(ua);
        lines.push(format!("Browser: {}", browser));
    }

    let message = SlackMessage {
        text: lines.join("\n"),
    };

    if let Err(err) = send_slack_message(webhook_url, &message).await {
        console_log!("[slack] Failed to send login notification: {:?}", err);
    }
}

fn parse_user_agent(ua: &str) -> String {
    let browser = if ua.contains("Chrome") && !ua.contains("Edg") {
        "Chrome"
    } else if ua.contains("Firefox") {
        "Firefox"
    } else if ua.contains("Safari") && !ua.contains("Chrome") {
        "Safari"
    } else if ua.contains("Edg") {
        "Edge"
    } else {
        "Unknown"
    };

    let os = if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Mac OS") {
        "macOS"
    } else if ua.contains("Linux") {
        "Linux"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("iPhone") || ua.contains("iPad") {
        "iOS"
    } else {
        "Unknown"
    };

    format!("{} / {}", browser, os)
}

async fn send_slack_message(webhook_url: &str, message: &SlackMessage) -> Result<(), String> {
    let url = Url::parse(webhook_url).map_err(|e| format!("Invalid webhook URL: {}", e))?;

    let body = serde_json::to_string(message)
        .map_err(|e| format!("Failed to serialize message: {}", e))?;

    let headers = Headers::new();
    headers
        .set("Content-Type", "application/json")
        .map_err(|e| format!("Failed to set header: {:?}", e))?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(body.into()));

    let request = Request::new_with_init(url.as_str(), &init)
        .map_err(|e| format!("Request error: {:?}", e))?;

    let response = Fetch::Request(request)
        .send()
        .await
        .map_err(|e| format!("Fetch error: {:?}", e))?;

    if response.status_code() != 200 {
        return Err(format!(
            "Slack returned status code: {}",
            response.status_code()
        ));
    }

    Ok(())
}
