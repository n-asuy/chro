//! Device path tests through a real router, state and database: dispatch,
//! streams shared with the desktop's WebSockets, the listener's handshake and
//! limits over real sockets, and the desktop's `/rpc/mobile/*`.

use std::{sync::Arc, time::Duration};

use axum::{
    body::Body,
    extract::{MatchedPath, Request},
    http::{HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use db::models::TaskRun;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;
use uuid::Uuid;

use super::{
    allowlist::ALLOWLIST,
    binary,
    connections::Caps,
    dispatch,
    dispatch::Limits,
    dispatch::{DeviceSession, Outbound, Queued},
    fake_link::{FakeLink, FakePhoneChannel},
    link::DeviceLink,
    link::{DeviceGrant, FrameKind, SourceClass},
    listener::{BindScope, PortChoice, Timing},
    mcp_redaction,
    network::InterfaceAddress,
    HubConfig, MobileHub,
};
use crate::{
    routes::{self, stream_sources::STREAM_TEMPLATES},
    test_support::{self, TestApp},
};

pub(super) const WAIT: Duration = Duration::from_secs(15);
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

fn quiet_config() -> HubConfig {
    HubConfig {
        interfaces: Arc::new(Vec::new),
        ..HubConfig::default()
    }
}

/// A device session driven straight through the dispatcher.
struct Device {
    app: TestApp,
    link: FakeLink,
    hub: Arc<MobileHub>,
    session: Arc<DeviceSession>,
    outbound: mpsc::Receiver<Queued>,
    device_id: Uuid,
    next_id: u64,
}

async fn device_with(is_ticket: bool) -> Device {
    let app = test_support::app().await;
    let link = FakeLink::default();
    let device_id = link.pair(TOKEN, is_ticket);
    let hub = MobileHub::new(app.state.clone(), Arc::new(link.clone()), quiet_config());
    let (tx, outbound) = mpsc::channel(1024);
    let session = hub.dispatcher().session(
        DeviceGrant {
            device_id,
            token: TOKEN.into(),
            revision: 1,
            is_ticket,
        },
        tx,
    );
    Device {
        app,
        link,
        hub,
        session,
        outbound,
        device_id,
        next_id: 0,
    }
}

/// A declared device whose requests reach `router` under `limits`.
async fn device_on(router: axum::Router, limits: Limits) -> Device {
    let app = test_support::app().await;
    let link = FakeLink::default();
    let device_id = link.pair(TOKEN, false);
    let hub = MobileHub::new(
        app.state.clone(),
        Arc::new(link.clone()),
        HubConfig {
            limits,
            router: Some(router),
            ..quiet_config()
        },
    );
    let (tx, outbound) = mpsc::channel(1024);
    let session = hub.dispatcher().session(
        DeviceGrant {
            device_id,
            token: TOKEN.into(),
            revision: 1,
            is_ticket: false,
        },
        tx,
    );
    let mut device = Device {
        app,
        link,
        hub,
        session,
        outbound,
        device_id,
        next_id: 0,
    };
    device.declare().await;
    device
}

async fn declared_device() -> Device {
    let mut device = device_with(false).await;
    let declared = device
        .call(
            "runtime.clientCapabilities.update",
            json!({"clientCapabilities": [], "apiGeneration": 1}),
        )
        .await;
    assert_eq!(declared["ok"], true, "{declared}");
    device
}

impl Device {
    async fn declare(&mut self) {
        let declared = self
            .call(
                "runtime.clientCapabilities.update",
                json!({"clientCapabilities": [], "apiGeneration": 1}),
            )
            .await;
        assert_eq!(declared["ok"], true, "{declared}");
    }

    async fn send(&mut self, method: &str, params: Value) -> String {
        self.next_id += 1;
        let id = format!("rpc-{}", self.next_id);
        let envelope = json!({"id": id, "deviceToken": TOKEN, "method": method, "params": params});
        self.hub
            .dispatcher()
            .on_text(&self.session, envelope.to_string().as_bytes())
            .await;
        id
    }

    async fn next(&mut self) -> Outbound {
        tokio::time::timeout(WAIT, self.outbound.recv())
            .await
            .expect("a reply in time")
            .expect("the session is open")
            .frame
    }

    async fn next_text(&mut self) -> Value {
        match self.next().await {
            Outbound::Text(text) => serde_json::from_str(&text).unwrap(),
            Outbound::Binary(_) => panic!("expected a text reply"),
        }
    }

    /// Send a call and return its reply, skipping replies of streams that
    /// interleave with it.
    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params).await;
        loop {
            let reply = self.next_text().await;
            if reply["id"] == id {
                return reply;
            }
            assert_eq!(reply["streaming"], true, "an unexpected reply: {reply}");
        }
    }

    /// `request` and its result (`{status, body}` or `{status, text}`).
    async fn request(&mut self, method: &str, path: &str, extra: Value) -> Value {
        let mut params = json!({"method": method, "path": path});
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().cloned().unwrap_or_default());
        let reply = self.call("request", params).await;
        assert_eq!(reply["ok"], true, "{method} {path}: {reply}");
        reply["result"].clone()
    }

    /// Collect a binary reply: its first header and the whole body.
    async fn binary_reply(&mut self) -> (serde_json::Map<String, Value>, Vec<u8>) {
        let mut first = None;
        let mut body = Vec::new();
        loop {
            let frame = match self.next().await {
                Outbound::Binary(frame) => frame,
                Outbound::Text(text) => panic!("expected a binary reply, got {text}"),
            };
            let (header, chunk) = binary::decode(&frame).unwrap();
            let position = binary::position(&header).unwrap();
            body.extend_from_slice(chunk);
            if first.is_none() {
                first = Some(header);
            }
            if position.is_final {
                return (first.unwrap(), body);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The RPC families.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn status_answers_before_the_api_is_declared() {
    let mut device = device_with(false).await;
    let reply = device.call("status.get", json!({"probe": true})).await;
    assert_eq!(reply["ok"], true);
    let result = &reply["result"];
    assert_eq!(result["apiGeneration"], 1);
    assert_eq!(
        result["capabilities"],
        json!([
            "pairing.ticket-exchange.v1",
            "stream.message-parts.v1",
            "sessions.list-window.v1"
        ])
    );
    assert_eq!(result["deviceId"], device.device_id.to_string());
    assert!(result["machineName"].is_string());
    assert!(reply["_meta"]["runtimeId"].is_string());
}

#[tokio::test]
async fn request_and_subscribe_need_the_api_generation_first() {
    let mut device = device_with(false).await;
    let refused = device
        .call("request", json!({"method": "GET", "path": "/v1/status"}))
        .await;
    assert_eq!(refused["error"]["code"], "incompatible_api");
    let refused = device
        .call("subscribe", json!({"stream": "/streams/tasks"}))
        .await;
    assert_eq!(refused["error"]["code"], "incompatible_api");

    let wrong = device
        .call(
            "runtime.clientCapabilities.update",
            json!({"clientCapabilities": ["x"], "apiGeneration": 2}),
        )
        .await;
    assert_eq!(wrong["error"]["code"], "incompatible_api");
    assert_eq!(wrong["error"]["data"]["apiGeneration"], 1);

    let declared = device
        .call(
            "runtime.clientCapabilities.update",
            json!({"clientCapabilities": ["transport.x"], "apiGeneration": 1}),
        )
        .await;
    assert_eq!(declared["result"]["apiGeneration"], 1);
    assert_eq!(device.session.client_capabilities(), vec!["transport.x"]);
    let result = device.request("GET", "/v1/status", json!({})).await;
    assert_eq!(result["status"], 200);
}

#[tokio::test]
async fn envelopes_are_checked_before_anything_runs() {
    let mut device = declared_device().await;
    device
        .hub
        .dispatcher()
        .on_text(&device.session, b"not json")
        .await;
    let reply = device.next_text().await;
    assert_eq!(reply["id"], "unknown");
    assert_eq!(reply["error"]["code"], "bad_request");

    let envelope = json!({"id": "x", "deviceToken": "someone-else", "method": "status.get"});
    device
        .hub
        .dispatcher()
        .on_text(&device.session, envelope.to_string().as_bytes())
        .await;
    let reply = device.next_text().await;
    assert_eq!(reply["id"], "x");
    assert_eq!(reply["error"]["code"], "unauthorized");
    assert_eq!(reply["error"]["message"], "Device token mismatch");

    let reply = device.call("terminal.list", json!({})).await;
    assert_eq!(reply["error"]["code"], "method_not_found");

    let reply = device
        .call(
            "request",
            json!({"method": "GET", "path": "/v1/status", "extra": 1}),
        )
        .await;
    assert_eq!(reply["error"]["code"], "invalid_argument");
}

#[tokio::test]
async fn the_operator_api_admits_devices_without_bearer_or_contract_headers() {
    let mut device = declared_device().await;
    let result = device.request("GET", "/v1/status", json!({})).await;
    assert_eq!(result["status"], 200);
    assert_eq!(result["body"]["ok"], true);
    assert_eq!(
        result["body"]["result"]["caller"]["kind"], "user",
        "{result}"
    );

    // The same request over HTTP carries no admission and is refused.
    let response = routes::api_router(device.app.state.clone())
        .oneshot(Request::get("/v1/status").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn endpoints_off_the_allowlist_are_forbidden_and_never_run() {
    let mut device = declared_device().await;
    for (method, path) in [
        ("GET", "/rpc/filesystem/cwd"),
        ("POST", "/rpc/developer/worktree-cleanup"),
        ("POST", "/rpc/mobile/pairing-offer"),
        ("POST", "/rpc/events/ui"),
        ("POST", "/v1/projects"),
        ("GET", "/rpc/filesystem/workspace-entries"),
        ("PUT", "/rpc/filesystem/workspace-file"),
        ("GET", "/rpc/executor/pi/credentials"),
        ("PUT", "/rpc/executor/pi/api-key"),
        ("PUT", "/rpc/executor/launch-settings"),
    ] {
        let reply = device
            .call("request", json!({"method": method, "path": path}))
            .await;
        assert_eq!(
            reply["error"]["code"], "forbidden",
            "{method} {path}: {reply}"
        );
    }
    let unknown = device
        .request("GET", "/rpc/no-such-endpoint", json!({}))
        .await;
    assert_eq!(unknown["status"], 404);
}

/// A paired device reads and edits MCP servers without ever receiving a
/// credential: env and header values, tokens in arguments and URLs, and the
/// raw text of a file that does not parse stay on the computer, and an edit
/// saved from the redacted view keeps the real values.
#[tokio::test]
async fn mcp_configuration_reaches_devices_without_its_credentials() {
    let _agent_config = test_support::agent_config_lock().await;
    let mut device = declared_device().await;
    let file = test_support::claude_config_file();
    const SECRETS: [&str; 5] = [
        "sk-live-0123456789abcdefghij",
        "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
        "url-token-77",
        "arg-secret-55",
        "hunter2pass",
    ];
    let original = json!({
        "theme": "dark",
        "mcpServers": {
            "search": {
                "command": "npx",
                "args": ["-y", "search-mcp", "--api-key", SECRETS[3]],
                "env": {"SEARCH_API_KEY": SECRETS[0]}
            },
            "remote": {
                "type": "http",
                "url": format!("https://bot:{}@mcp.example.com/sse?token={}", SECRETS[4], SECRETS[2]),
                "headers": {"Authorization": format!("Bearer {}", SECRETS[1])}
            }
        }
    });
    std::fs::write(&file, serde_json::to_string_pretty(&original).unwrap()).unwrap();
    let query = json!({"query": {"executor": "CLAUDE_CODE"}});
    let assert_hidden = |reply: &Value| {
        let text = reply.to_string();
        for secret in SECRETS {
            assert!(
                !text.contains(secret),
                "{secret} reached the device: {text}"
            );
        }
    };

    let read = device
        .request("GET", "/rpc/mcp-config", query.clone())
        .await;
    assert_eq!(read["status"], 200, "{read}");
    assert_hidden(&read);
    let servers = &read["body"]["mcp_config"]["servers"];
    assert_eq!(
        servers["search"]["env"]["SEARCH_API_KEY"],
        mcp_redaction::HIDDEN
    );
    assert_eq!(servers["search"]["args"][2], "--api-key");
    assert_eq!(read["body"]["raw_content"], Value::Null);

    // The desktop still sees the real values.
    let (status, desktop) = rpc(
        &device.app,
        Method::GET,
        "/rpc/mcp-config?executor=CLAUDE_CODE",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        desktop["mcp_config"]["servers"]["search"]["env"]["SEARCH_API_KEY"],
        SECRETS[0]
    );

    // An edit from the redacted view keeps every hidden value.
    let mut edited = servers.clone();
    edited["search"]["env"]["REGION"] = json!("eu");
    edited["search"]["args"]
        .as_array_mut()
        .unwrap()
        .insert(0, json!("--quiet"));
    let saved = device
        .request(
            "PUT",
            "/rpc/mcp-config",
            json!({"query": {"executor": "CLAUDE_CODE"}, "body": {"servers": edited}}),
        )
        .await;
    assert_eq!(saved["status"], 200, "{saved}");
    assert_hidden(&saved);
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    let mut expected = original.clone();
    expected["mcpServers"]["search"]["env"]["REGION"] = json!("eu");
    expected["mcpServers"]["search"]["args"]
        .as_array_mut()
        .unwrap()
        .insert(0, json!("--quiet"));
    assert_eq!(
        on_disk, expected,
        "real values kept, placeholders never written"
    );

    // A placeholder that no longer traces back is refused, file untouched.
    let mut renamed = servers.clone();
    let search = renamed.as_object_mut().unwrap().remove("search").unwrap();
    renamed["search-renamed"] = search;
    let refused = device
        .request(
            "PUT",
            "/rpc/mcp-config",
            json!({"query": {"executor": "CLAUDE_CODE"}, "body": {"servers": renamed}}),
        )
        .await;
    assert_eq!(refused["status"], 400, "{refused}");
    let after: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(after, expected);

    // A file that does not parse: no raw text, no parser quote, no save.
    let malformed = format!(
        "{{\"mcpServers\": {{\"x\": {{\"env\": {{\"K\": \"{}\"",
        SECRETS[0]
    );
    std::fs::write(&file, &malformed).unwrap();
    let read = device.request("GET", "/rpc/mcp-config", query).await;
    assert_eq!(read["status"], 200, "{read}");
    assert_hidden(&read);
    assert_eq!(read["body"]["raw_content"], Value::Null);
    assert!(read["body"]["parse_error"].is_string(), "{read}");
    let refused = device
        .request(
            "PUT",
            "/rpc/mcp-config",
            json!({"query": {"executor": "CLAUDE_CODE"}, "body": {"servers": {}}}),
        )
        .await;
    assert_eq!(refused["status"], 400, "{refused}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), malformed);
    std::fs::remove_file(&file).unwrap();
}

/// The routes a phone gained for shared settings, opening folders and the
/// Files panel answer through the dispatcher as they do for the desktop.
#[tokio::test]
async fn shared_settings_folders_and_file_operations_answer_devices() {
    let _agent_config = test_support::agent_config_lock().await;
    let mut device = declared_device().await;
    let ok = |result: &Value| assert_eq!(result["status"], 200, "{result}");

    let saved = device
        .request(
            "PUT",
            "/rpc/ui-state",
            json!({"body": {"chro.phoneCheck": [1, 2]}}),
        )
        .await;
    ok(&saved);
    let state = device.request("GET", "/rpc/ui-state", json!({})).await;
    ok(&state);
    assert_eq!(state["body"]["ui_state"]["chro.phoneCheck"], json!([1, 2]));

    let accent = device
        .request(
            "PUT",
            "/rpc/preferences/appearance",
            json!({"body": {"accent": "#7C3AED"}}),
        )
        .await;
    ok(&accent);
    let appearance = device
        .request("GET", "/rpc/preferences/appearance", json!({}))
        .await;
    assert_eq!(
        appearance["body"]["appearance"]["accent"], "#7c3aed",
        "{appearance}"
    );

    let query = json!({"query": {"executor": "CLAUDE_CODE"}});
    let mcp = device
        .request("GET", "/rpc/mcp-config", query.clone())
        .await;
    ok(&mcp);
    assert!(mcp["body"]["servers_count"].is_u64(), "{mcp}");
    let status = device
        .request("GET", "/rpc/executor/mcp-status", query)
        .await;
    ok(&status);

    // Opening a folder: list the parent, then register the folder.
    let folder = device.app.dir.path().join("picked");
    std::fs::create_dir_all(&folder).unwrap();
    let parent = device.app.dir.path().to_string_lossy().into_owned();
    let listing = device
        .request(
            "GET",
            "/rpc/filesystem/directory",
            json!({"query": {"path": parent}}),
        )
        .await;
    ok(&listing);
    assert!(
        listing["body"]["entries"].to_string().contains("picked"),
        "{listing}"
    );
    let ensured = device
        .request(
            "POST",
            "/rpc/projects/ensure",
            json!({"body": {"git_repo_path": folder.to_string_lossy()}}),
        )
        .await;
    ok(&ensured);

    // The Files panel: new folder, duplicate, rename, delete.
    let project = device.app.project("files").await;
    let root = format!("/rpc/projects/{}", project.id);
    ok(&device
        .request(
            "POST",
            &format!("{root}/directory"),
            json!({"body": {"relative_path": "notes"}}),
        )
        .await);
    ok(&device
        .request(
            "POST",
            &format!("{root}/copy"),
            json!({"body": {"source_relative_path": "README.md", "dest_relative_path": "notes/copy.md"}}),
        )
        .await);
    ok(&device
        .request(
            "POST",
            &format!("{root}/rename"),
            json!({"body": {"old_relative_path": "notes/copy.md", "new_relative_path": "notes/moved.md"}}),
        )
        .await);
    let repo = std::path::Path::new(&project.git_repo_path);
    assert!(repo.join("notes/moved.md").is_file());
    ok(&device
        .request(
            "DELETE",
            &format!("{root}/file"),
            json!({"query": {"relative_path": "notes/moved.md"}}),
        )
        .await);
    assert!(!repo.join("notes/moved.md").exists());
}

#[tokio::test]
async fn every_allowlisted_template_is_the_route_the_router_matches() {
    // Swap the gate for a probe that reports the matched route without
    // running any handler, so no endpoint has side effects here.
    async fn probe(request: Request, _next: Next) -> Response {
        let matched = request
            .extensions()
            .get::<MatchedPath>()
            .map(|path| path.as_str().to_string())
            .unwrap_or_default();
        let mut response = StatusCode::NO_CONTENT.into_response();
        response
            .headers_mut()
            .insert("x-matched", HeaderValue::from_str(&matched).unwrap());
        response
    }
    let app = test_support::app().await;
    let router = routes::api_router(app.state.clone()).route_layer(middleware::from_fn(probe));

    let fill = |template: &str| {
        template
            .split('/')
            .map(|segment| {
                if segment.starts_with(':') {
                    "segment".to_string()
                } else if segment.starts_with('*') {
                    "nested/file.md".to_string()
                } else {
                    segment.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("/")
    };
    for entry in ALLOWLIST {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(entry.method.clone())
                    .uri(fill(entry.template))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response
                .headers()
                .get("x-matched")
                .map(|v| v.to_str().unwrap()),
            Some(entry.template),
            "{} {} does not name a route ({})",
            entry.method,
            entry.template,
            response.status()
        );
    }
    for template in STREAM_TEMPLATES {
        let path = template.split('?').next().unwrap();
        let response = router
            .clone()
            .oneshot(Request::get(fill(path)).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            response
                .headers()
                .get("x-matched")
                .map(|v| v.to_str().unwrap()),
            Some(path),
            "stream {path} does not name a route"
        );
    }
}

#[tokio::test]
async fn json_text_and_empty_replies_keep_their_status() {
    let mut device = declared_device().await;
    let project = device.app.project("repo").await;
    let task = device.app.task(&project, "A session").await;

    let listed = device.request("GET", "/rpc/projects", json!({})).await;
    assert_eq!(listed["status"], 200);
    assert!(
        listed["body"].is_array() || listed["body"].is_object(),
        "{listed}"
    );

    let file = device
        .request(
            "GET",
            &format!("/rpc/projects/{}/file", project.id),
            json!({"query": {"relative_path": "README.md"}}),
        )
        .await;
    assert_eq!(file["status"], 200, "{file}");
    assert!(file.to_string().contains("# fixture"), "{file}");

    let missing = device
        .request(
            "GET",
            &format!("/rpc/tasks/{}/last-message", test_support::missing_id()),
            json!({}),
        )
        .await;
    assert_eq!(missing["status"], 404);

    let renamed = device
        .request(
            "PATCH",
            &format!("/rpc/tasks/{}/title", task.id),
            json!({"body": {"title": "Renamed from the phone"}}),
        )
        .await;
    assert!(renamed["status"].as_u64().unwrap() < 300, "{renamed}");
}

#[tokio::test]
async fn images_upload_in_chunks_and_download_as_binary() {
    let mut device = declared_device().await;
    let image: Vec<u8> = (0..(binary::CHUNK_BYTES + 1000))
        .map(|n| (n % 251) as u8)
        .collect();
    let (first, second) = image.split_at(binary::CHUNK_BYTES);
    let id = "upload-1";
    let header = json!({
        "id": id, "seq": 0, "final": false, "deviceToken": TOKEN, "method": "request",
        "params": {
            "method": "POST",
            "path": "/rpc/images/upload",
            "upload": {"field": "image", "fileName": "shelf.png", "contentType": "image/png"},
        },
    });
    let dispatcher = device.hub.dispatcher().clone();
    dispatcher
        .on_binary(&device.session, &binary::encode(&header, first))
        .await;
    dispatcher
        .on_binary(
            &device.session,
            &binary::encode(&json!({"id": id, "seq": 1, "final": true}), second),
        )
        .await;
    let reply = device.next_text().await;
    assert_eq!(reply["id"], id);
    assert_eq!(reply["result"]["status"], 200, "{reply}");
    let image_id = reply["result"]["body"]["image"]["id"]
        .as_str()
        .expect("an image id")
        .to_string();

    device
        .send(
            "request",
            json!({"method": "GET", "path": format!("/rpc/images/{image_id}/file")}),
        )
        .await;
    let (header, body) = device.binary_reply().await;
    assert_eq!(header["ok"], true);
    assert_eq!(header["result"]["status"], 200);
    assert_eq!(header["result"]["contentType"], "image/png");
    assert_eq!(header["result"]["contentLength"], image.len());
    assert_eq!(body, image);
}

#[tokio::test]
async fn malformed_uploads_are_refused_with_their_id() {
    let mut device = declared_device().await;
    let dispatcher = device.hub.dispatcher().clone();

    dispatcher
        .on_binary(
            &device.session,
            &binary::encode(&json!({"id": "u", "seq": 3, "final": true}), b"x"),
        )
        .await;
    let reply = device.next_text().await;
    assert_eq!(reply["id"], "u");
    assert_eq!(reply["error"]["code"], "bad_request");

    let wrong_token = json!({
        "id": "v", "seq": 0, "final": true, "deviceToken": "nope", "method": "request",
        "params": {"method": "POST", "path": "/rpc/images/upload",
                   "upload": {"field": "image", "fileName": "a.png", "contentType": "image/png"}},
    });
    dispatcher
        .on_binary(&device.session, &binary::encode(&wrong_token, b"x"))
        .await;
    assert_eq!(device.next_text().await["error"]["code"], "unauthorized");

    let reply = device
        .call(
            "request",
            json!({"method": "POST", "path": "/rpc/images/upload",
                   "upload": {"field": "image", "fileName": "a.png", "contentType": "image/png"}}),
        )
        .await;
    assert_eq!(
        reply["error"]["code"], "invalid_argument",
        "uploads need binary frames"
    );
}

#[tokio::test]
async fn ticket_exchange_follows_the_registry() {
    let mut device = device_with(true).await;
    let new_token = "ab".repeat(24);
    let reply = device
        .call("pairing.exchangeTicket", json!({"deviceToken": new_token}))
        .await;
    assert_eq!(
        reply["result"]["deviceId"],
        device.device_id.to_string(),
        "{reply}"
    );
    assert_eq!(device.link.token_of(device.device_id).unwrap(), new_token);

    let again = device
        .call("pairing.exchangeTicket", json!({"deviceToken": new_token}))
        .await;
    assert_eq!(again["ok"], true, "repeating the same exchange succeeds");

    let malformed = device
        .call("pairing.exchangeTicket", json!({"deviceToken": "XYZ"}))
        .await;
    assert_eq!(malformed["error"]["code"], "invalid_argument");

    let mut paired = declared_device().await;
    let refused = paired
        .call(
            "pairing.exchangeTicket",
            json!({"deviceToken": "cd".repeat(24)}),
        )
        .await;
    assert_eq!(refused["error"]["code"], "not_a_ticket");
}

// ---------------------------------------------------------------------------
// Streams: the device path and the desktop WebSockets share their sources.
// ---------------------------------------------------------------------------

async fn serve_http(app: &TestApp) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = routes::api_router(app.state.clone());
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service())
            .await
            .unwrap();
    });
    port
}

pub(super) type Client = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

pub(super) async fn ws_connect(port: u16, path: &str) -> Client {
    let (socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}{path}"))
        .await
        .expect("websocket connects");
    socket
}

async fn ws_next_text(socket: &mut Client) -> Value {
    loop {
        let message = tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("a message in time")
            .expect("open")
            .expect("readable");
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

/// Subscribe and return the subscription id and request id.
async fn subscribe(device: &mut Device, stream: &str, params: Value) -> (String, String) {
    let id = device
        .send("subscribe", json!({"stream": stream, "params": params}))
        .await;
    let ready = device.next_text().await;
    assert_eq!(ready["id"], id, "{ready}");
    assert_eq!(ready["streaming"], true, "{ready}");
    assert_eq!(ready["result"]["type"], "ready", "{ready}");
    (
        ready["result"]["subscriptionId"]
            .as_str()
            .unwrap()
            .to_string(),
        id,
    )
}

async fn next_stream_message(device: &mut Device) -> Value {
    let reply = device.next_text().await;
    assert_eq!(reply["streaming"], true, "{reply}");
    reply["result"].clone()
}

#[tokio::test]
async fn a_task_snapshot_is_identical_over_websocket_and_subscribe() {
    let mut device = declared_device().await;
    let project = device.app.project("repo").await;
    device.app.task(&project, "Shared snapshot").await;
    let port = serve_http(&device.app).await;

    let mut socket = ws_connect(port, &format!("/streams/tasks?project_id={}", project.id)).await;
    let over_ws = ws_next_text(&mut socket).await;

    let (subscription, _) = subscribe(
        &mut device,
        "/streams/tasks",
        json!({"project_id": project.id}),
    )
    .await;
    let message = next_stream_message(&mut device).await;
    assert_eq!(message["type"], "message");
    assert_eq!(message["subscriptionId"], subscription);
    assert_eq!(message["data"], over_ws);
    assert!(over_ws.to_string().contains("Shared snapshot"), "{over_ws}");
}

/// Eight tasks whose descriptions together make a snapshot over 4 MiB: multibyte
/// text and characters JSON escapes, so parts must split on character boundaries.
async fn oversized_task_snapshot(app: &TestApp) -> db::models::ProjectRecord {
    let project = app.project("repo").await;
    let line = "説明 \"quoted\" \\ tab\t newline\n ".repeat(20_000);
    for index in 0..8 {
        let task =
            db::models::TaskRecord::new(project.id, format!("Big {index}"), Some(line.clone()));
        task.insert(app.pool()).await.unwrap();
    }
    project
}

#[tokio::test]
async fn an_oversized_stream_message_reaches_a_device_that_takes_parts() {
    let mut device = device_with(false).await;
    let declared = device
        .call(
            "runtime.clientCapabilities.update",
            json!({"clientCapabilities": [dispatch::MESSAGE_PARTS_CAPABILITY], "apiGeneration": 1}),
        )
        .await;
    assert_eq!(declared["ok"], true, "{declared}");
    assert!(declared["result"]["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!(dispatch::MESSAGE_PARTS_CAPABILITY)));
    let project = oversized_task_snapshot(&device.app).await;
    let port = serve_http(&device.app).await;

    let mut socket = ws_connect(port, &format!("/streams/tasks?project_id={}", project.id)).await;
    let over_ws = tokio::time::timeout(WAIT, socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(over_ws) = over_ws else {
        panic!("a text snapshot")
    };
    assert!(
        over_ws.len() > dispatch::MAX_JSON_REPLY_BYTES,
        "{}",
        over_ws.len()
    );

    let (subscription, request) = subscribe(
        &mut device,
        "/streams/tasks",
        json!({"project_id": project.id}),
    )
    .await;
    let mut text = String::new();
    let mut parts = 0;
    loop {
        let reply = device.next_text().await;
        assert!(reply.to_string().len() <= dispatch::MAX_JSON_REPLY_BYTES);
        assert_eq!(reply["id"], request);
        let result = &reply["result"];
        assert_eq!(result["type"], "part", "{}", &result.to_string()[..200]);
        assert_eq!(result["subscriptionId"], subscription);
        text.push_str(result["text"].as_str().unwrap());
        parts += 1;
        if result["final"] == true {
            break;
        }
        assert_eq!(result["final"], false);
    }
    assert!(parts > 1);
    assert_eq!(
        text,
        over_ws.as_str(),
        "the parts join to the websocket's bytes"
    );
    assert_eq!(device.session.subscription_count(), 1, "the stream goes on");

    // Later messages that fit still come whole.
    device.app.task(&project, "Small one").await;
    let message = next_stream_message(&mut device).await;
    assert_eq!(message["type"], "message", "{message}");
    assert!(message["data"].to_string().contains("Small one"));
}

#[tokio::test]
async fn the_session_list_carries_what_the_phone_reads_in_one_message() {
    let mut device = declared_device().await;
    let project = oversized_task_snapshot(&device.app).await;
    let archived = device.app.task(&project, "Archived one").await;
    db::models::TaskRecord::update_status(
        device.app.pool(),
        archived.id,
        db::types::TaskStatus::Cancelled,
    )
    .await
    .unwrap();
    let port = serve_http(&device.app).await;

    let mut socket = ws_connect(port, "/streams/session-list?limit=5").await;
    let over_ws = ws_next_text(&mut socket).await;
    let (subscription, _) =
        subscribe(&mut device, "/streams/session-list", json!({"limit": 5})).await;
    let message = next_stream_message(&mut device).await;
    assert_eq!(message["type"], "message", "the window fits one reply");
    assert_eq!(message["subscriptionId"], subscription);
    assert_eq!(message["data"], over_ws);

    let patch = &over_ws["payload"];
    let tasks = patch[0]["value"].as_object().unwrap();
    assert_eq!(
        tasks.len(),
        8,
        "the newest of the project, archived left out"
    );
    assert!(tasks.values().all(|task| task.get("description").is_none()));
    assert!(!tasks.contains_key(&archived.id.to_string()));
    assert_eq!(
        patch[1]["value"][project.id.to_string()],
        json!({"live": 8, "archived": 1})
    );
    assert!(
        over_ws.to_string().len() < 16 * 1024,
        "{}",
        over_ws.to_string().len()
    );
}

#[tokio::test]
async fn the_session_list_lookups_answer_devices() {
    let mut device = declared_device().await;
    let project = device.app.project("repo").await;
    let task = device.app.task(&project, "Find me").await;
    device.app.task(&project, "Other").await;

    let found = device
        .request("GET", "/rpc/session-list", json!({"query": {"q": "find"}}))
        .await;
    assert_eq!(found["status"], 200, "{found}");
    assert_eq!(found["body"]["total"], 1);
    assert_eq!(found["body"]["sessions"][0]["id"], task.id.to_string());

    let refused = device
        .request("GET", "/rpc/session-list", json!({"query": {"limit": 0}}))
        .await;
    assert_eq!(refused["status"], 400, "{refused}");
}

#[tokio::test]
async fn an_oversized_stream_message_ends_the_subscription_of_a_device_without_parts() {
    let mut device = declared_device().await;
    let project = oversized_task_snapshot(&device.app).await;
    let (subscription, _) = subscribe(
        &mut device,
        "/streams/tasks",
        json!({"project_id": project.id}),
    )
    .await;
    let end = next_stream_message(&mut device).await;
    assert_eq!(end["type"], "end");
    assert_eq!(end["subscriptionId"], subscription);
    assert_eq!(end["error"]["code"], "reply_too_large");
}

#[tokio::test]
async fn log_streams_start_with_the_replay_marker_on_both_paths() {
    let mut device = declared_device().await;
    let project = device.app.project("repo").await;
    let task = device.app.task(&project, "Logs").await;
    let run = TaskRun::new_local(task.id, None);
    run.insert(device.app.pool()).await.unwrap();
    let port = serve_http(&device.app).await;

    let mut socket = ws_connect(port, &format!("/streams/task-runs/{}/logs", run.id)).await;
    assert_eq!(
        ws_next_text(&mut socket).await,
        json!({"replayStarted": true})
    );

    subscribe(
        &mut device,
        "/streams/task-runs/:id/logs",
        json!({"id": run.id}),
    )
    .await;
    let message = next_stream_message(&mut device).await;
    assert_eq!(message["data"], json!({"replayStarted": true}));

    // An unknown run is refused before the upgrade, as before.
    let refused = tokio_tungstenite::connect_async(format!(
        "ws://127.0.0.1:{port}/streams/task-runs/{}/logs",
        test_support::missing_id()
    ))
    .await;
    match refused {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status(), StatusCode::NOT_FOUND)
        }
        other => panic!("expected a 404 before the upgrade, got {other:?}"),
    }
    let reply = device
        .call(
            "subscribe",
            json!({"stream": "/streams/task-runs/:id/logs", "params": {"id": test_support::missing_id()}}),
        )
        .await;
    assert_eq!(reply["error"]["code"], "not_found");
}

#[tokio::test]
async fn a_diff_that_cannot_start_reports_and_ends_on_both_paths() {
    let mut device = declared_device().await;
    let project = device.app.project("repo").await;
    let task = device.app.task(&project, "No worktree").await;
    let run = TaskRun::new_local(task.id, None);
    run.insert(device.app.pool()).await.unwrap();
    let port = serve_http(&device.app).await;

    let mut socket = ws_connect(port, &format!("/rpc/task-runs/{}/diff", run.id)).await;
    let first = ws_next_text(&mut socket).await;
    assert!(first.get("error").is_some(), "{first}");
    let close = tokio::time::timeout(WAIT, socket.next()).await.unwrap();
    match close {
        Some(Ok(Message::Close(Some(frame)))) => {
            assert_eq!(u16::from(frame.code), 1000);
            assert_eq!(frame.reason, "diff stream ended");
        }
        other => panic!("expected the normal-closure frame, got {other:?}"),
    }

    let (subscription, _) = subscribe(
        &mut device,
        "/rpc/task-runs/:id/diff",
        json!({"id": run.id}),
    )
    .await;
    let message = next_stream_message(&mut device).await;
    assert_eq!(message["data"], first);
    let end = next_stream_message(&mut device).await;
    assert_eq!(end, json!({"type": "end", "subscriptionId": subscription}));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(device.session.subscription_count(), 0);
}

#[tokio::test]
async fn unsubscribing_stops_the_stream() {
    let mut device = declared_device().await;
    let project = device.app.project("repo").await;
    let (subscription, _) = subscribe(
        &mut device,
        "/streams/tasks",
        json!({"project_id": project.id}),
    )
    .await;
    next_stream_message(&mut device).await;
    assert_eq!(device.session.subscription_count(), 1);

    let reply = device
        .call(
            "subscribe.unsubscribe",
            json!({"subscriptionId": subscription}),
        )
        .await;
    assert_eq!(reply["ok"], true);
    assert_eq!(device.session.subscription_count(), 0);

    device.app.task(&project, "After unsubscribe").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        device.outbound.try_recv().is_err(),
        "no messages after unsubscribing"
    );

    let again = device
        .call(
            "subscribe.unsubscribe",
            json!({"subscriptionId": subscription}),
        )
        .await;
    assert_eq!(again["error"]["code"], "not_found");
}

#[tokio::test]
async fn subscribing_to_unknown_or_malformed_streams_fails() {
    let mut device = declared_device().await;
    let unknown = device
        .call("subscribe", json!({"stream": "/streams/browser"}))
        .await;
    assert_eq!(unknown["error"]["code"], "not_found");
    let missing_param = device
        .call(
            "subscribe",
            json!({"stream": "/streams/tasks/:task_id/runs"}),
        )
        .await;
    assert_eq!(missing_param["error"]["code"], "invalid_argument");
    let nested = device
        .call(
            "subscribe",
            json!({"stream": "/streams/tasks", "params": {"project_id": {"a": 1}}}),
        )
        .await;
    assert_eq!(nested["error"]["code"], "invalid_argument");
}

#[tokio::test]
async fn repo_events_reach_a_subscribed_device() {
    let mut device = declared_device().await;
    let project = device.app.project("repo").await;
    subscribe(
        &mut device,
        "/streams/projects/:project_id/repo-events",
        json!({"project_id": project.id}),
    )
    .await;
    // Give the watcher a moment to start before changing the tree.
    tokio::time::sleep(Duration::from_millis(500)).await;
    std::fs::write(
        std::path::Path::new(&project.git_repo_path).join("notes.md"),
        "changed",
    )
    .unwrap();
    let message = next_stream_message(&mut device).await;
    assert_eq!(message["data"]["type"], "repo_event", "{message}");
}

// ---------------------------------------------------------------------------
// The listener over real sockets.
// ---------------------------------------------------------------------------

struct Listening {
    app: TestApp,
    link: FakeLink,
    hub: Arc<MobileHub>,
    port: u16,
    device_id: Uuid,
}

async fn listening(caps: Caps, timing: Timing) -> Listening {
    listening_with(HubConfig {
        caps,
        timing,
        ..quiet_config()
    })
    .await
}

async fn listening_with(config: HubConfig) -> Listening {
    let app = test_support::app().await;
    // Every test of the process loads one shared config file; start from no
    // saved custom address whatever an earlier test wrote.
    app.state
        .runtime()
        .update_config(|config| config.mobile_pairing = Default::default())
        .await
        .unwrap();
    let link = FakeLink::default();
    let device_id = link.pair(TOKEN, false);
    let hub = MobileHub::new(app.state.clone(), Arc::new(link.clone()), config);
    let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = hub.open(socket).await.unwrap();
    app.state.install_mobile(Arc::clone(&hub));
    Listening {
        app,
        link,
        hub,
        port,
        device_id,
    }
}

struct Phone {
    socket: Client,
    channel: FakePhoneChannel,
    next_id: u64,
}

/// Open a socket and run the handshake as `token`.
async fn connect_phone(port: u16, token: &str) -> Result<Phone, Option<u16>> {
    let mut socket = ws_connect(port, "/any/path").await;
    socket.send(Message::Text("hello".into())).await.unwrap();
    match socket.next().await {
        Some(Ok(Message::Text(text))) => assert_eq!(text, "ready"),
        other => panic!("expected ready, got {other:?}"),
    }
    let mut channel = FakePhoneChannel::default();
    let auth = channel.seal(FrameKind::Text, token.as_bytes());
    socket
        .send(Message::Text(STANDARD.encode(auth)))
        .await
        .unwrap();
    match socket.next().await {
        Some(Ok(Message::Text(text))) => {
            let sealed = STANDARD.decode(text).unwrap();
            let reply = channel.open(FrameKind::Text, &sealed).unwrap();
            if reply == b"authenticated" {
                return Ok(Phone {
                    socket,
                    channel,
                    next_id: 0,
                });
            }
            Err(close_code(&mut socket).await)
        }
        Some(Ok(Message::Close(frame))) => Err(frame.map(|frame| u16::from(frame.code))),
        other => panic!("unexpected {other:?}"),
    }
}

/// Read until the socket ends: the close code, or `None` when it was cut
/// without a close frame.
pub(super) async fn close_code(socket: &mut Client) -> Option<u16> {
    loop {
        match tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("ends in time")
        {
            Some(Ok(Message::Close(frame))) => return frame.map(|frame| u16::from(frame.code)),
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return None,
        }
    }
}

impl Phone {
    async fn send_rpc(&mut self, method: &str, params: Value) -> String {
        self.next_id += 1;
        let id = format!("rpc-{}", self.next_id);
        let envelope = json!({"id": id, "deviceToken": TOKEN, "method": method, "params": params});
        let sealed = self
            .channel
            .seal(FrameKind::Text, envelope.to_string().as_bytes());
        self.socket
            .send(Message::Text(STANDARD.encode(sealed)))
            .await
            .unwrap();
        id
    }

    async fn reply(&mut self) -> Value {
        loop {
            let message = tokio::time::timeout(WAIT, self.socket.next())
                .await
                .expect("a reply in time")
                .expect("open")
                .expect("readable");
            if let Message::Text(text) = message {
                let sealed = STANDARD.decode(text).unwrap();
                let plaintext = self.channel.open(FrameKind::Text, &sealed).unwrap();
                return serde_json::from_slice(&plaintext).unwrap();
            }
        }
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.send_rpc(method, params).await;
        loop {
            let reply = self.reply().await;
            if reply["id"] == id {
                return reply;
            }
            assert_eq!(reply["streaming"], true, "an unexpected reply: {reply}");
        }
    }
}

fn fast_timing() -> Timing {
    Timing {
        handshake: Duration::from_millis(400),
        heartbeat: Duration::from_millis(100),
        heartbeat_misses: 3,
        ..Timing::default()
    }
}

#[tokio::test]
async fn a_paired_phone_handshakes_and_calls_over_the_socket() {
    let server = listening(Caps::default(), Timing::default()).await;
    let mut phone = connect_phone(server.port, TOKEN)
        .await
        .expect("authenticated");
    assert_eq!(server.hub.table().connections_of(server.device_id), 1);
    assert_eq!(
        server.link.last_source(server.device_id),
        Some(SourceClass::Loopback)
    );

    let status = phone.call("status.get", json!({})).await;
    assert_eq!(status["result"]["deviceId"], server.device_id.to_string());
    phone
        .call(
            "runtime.clientCapabilities.update",
            json!({"clientCapabilities": [], "apiGeneration": 1}),
        )
        .await;
    let projects = phone
        .call("request", json!({"method": "GET", "path": "/rpc/projects"}))
        .await;
    assert_eq!(projects["result"]["status"], 200, "{projects}");

    phone.socket.close(None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(server.hub.table().connections_of(server.device_id), 0);
}

#[tokio::test]
async fn an_unknown_token_gets_a_sealed_error_and_4001() {
    let server = listening(Caps::default(), Timing::default()).await;
    let refused = connect_phone(server.port, "not-a-device").await;
    assert_eq!(refused.err(), Some(Some(4001)));
}

#[tokio::test]
async fn a_binary_first_frame_is_an_invalid_handshake() {
    let server = listening(Caps::default(), Timing::default()).await;
    let mut socket = ws_connect(server.port, "/").await;
    socket.send(Message::Binary(vec![1, 2, 3])).await.unwrap();
    assert_eq!(close_code(&mut socket).await, Some(4001));
}

#[tokio::test]
async fn a_silent_socket_times_out_the_handshake() {
    let server = listening(Caps::default(), fast_timing()).await;
    let mut socket = ws_connect(server.port, "/").await;
    assert_eq!(close_code(&mut socket).await, Some(4002));
}

#[tokio::test]
async fn messages_over_one_mebibyte_close_with_1009() {
    let server = listening(Caps::default(), Timing::default()).await;
    let mut phone = connect_phone(server.port, TOKEN).await.unwrap();
    // The server may close while the message is still being written.
    let _ = phone
        .socket
        .send(Message::Text("A".repeat(1024 * 1024 + 16)))
        .await;
    assert_eq!(close_code(&mut phone.socket).await, Some(1009));
}

#[tokio::test]
async fn five_undecryptable_frames_in_a_row_close_with_4003() {
    let server = listening(Caps::default(), Timing::default()).await;
    let mut phone = connect_phone(server.port, TOKEN).await.unwrap();
    for _ in 0..4 {
        phone
            .socket
            .send(Message::Text(STANDARD.encode(b"garbage frame!")))
            .await
            .unwrap();
    }
    // A good frame resets the count.
    let status = phone.call("status.get", json!({})).await;
    assert_eq!(status["ok"], true);
    for _ in 0..5 {
        phone
            .socket
            .send(Message::Text(STANDARD.encode(b"garbage frame!")))
            .await
            .unwrap();
    }
    assert_eq!(close_code(&mut phone.socket).await, Some(4003));
}

#[tokio::test]
async fn revoking_a_device_cuts_its_socket_at_once() {
    let server = listening(Caps::default(), Timing::default()).await;
    let mut phone = connect_phone(server.port, TOKEN).await.unwrap();

    let response = routes::api_router(server.app.state.clone())
        .oneshot(
            Request::delete(format!("/rpc/mobile/devices/{}", server.device_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        close_code(&mut phone.socket).await,
        None,
        "terminated, no close frame"
    );
    assert!(server.link.token_of(server.device_id).is_none());
    assert!(
        connect_phone(server.port, TOKEN).await.is_err(),
        "the token no longer pairs"
    );
}

#[tokio::test]
async fn a_changed_credential_closes_on_the_next_frame() {
    let server = listening(Caps::default(), Timing::default()).await;
    let mut phone = connect_phone(server.port, TOKEN).await.unwrap();
    server.link.rotate_token(server.device_id, &"ee".repeat(24));
    phone.send_rpc("status.get", json!({})).await;
    assert_eq!(close_code(&mut phone.socket).await, Some(4001));
}

#[tokio::test]
async fn a_phone_that_stops_answering_pings_is_terminated() {
    let server = listening(Caps::default(), fast_timing()).await;
    let mut phone = connect_phone(server.port, TOKEN).await.unwrap();
    // Not reading means not answering pings.
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(server.hub.table().connections_of(server.device_id), 0);
    assert_eq!(close_code(&mut phone.socket).await, None);
}

#[tokio::test]
async fn a_phone_that_answers_pings_stays_connected() {
    let server = listening(Caps::default(), fast_timing()).await;
    let mut phone = connect_phone(server.port, TOKEN).await.unwrap();
    // Reading lets the client answer each ping.
    let read = tokio::time::timeout(Duration::from_millis(900), async {
        while let Some(Ok(_)) = phone.socket.next().await {}
    })
    .await;
    assert!(read.is_err(), "still open after several heartbeats");
    assert_eq!(server.hub.table().connections_of(server.device_id), 1);
}

#[tokio::test]
async fn websockets_over_the_cap_are_refused_with_1013() {
    let server = listening(
        Caps {
            websockets: 1,
            ..Caps::default()
        },
        Timing::default(),
    )
    .await;
    let _first = connect_phone(server.port, TOKEN).await.unwrap();
    let mut second = ws_connect(server.port, "/").await;
    assert_eq!(close_code(&mut second).await, Some(1013));
}

// ---------------------------------------------------------------------------
// Request limits, ownership and standing.
// ---------------------------------------------------------------------------

/// Handlers that block until released, counting who got in and who finished.
#[derive(Clone)]
struct Gate {
    entered: Arc<std::sync::atomic::AtomicUsize>,
    finished: Arc<std::sync::atomic::AtomicUsize>,
    open: Arc<tokio::sync::Semaphore>,
}

impl Gate {
    fn new() -> Self {
        Self {
            entered: Arc::default(),
            finished: Arc::default(),
            open: Arc::new(tokio::sync::Semaphore::new(0)),
        }
    }

    fn entered(&self) -> usize {
        self.entered.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn finished(&self) -> usize {
        self.finished.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn release(&self) {
        self.open.add_permits(1 << 20);
    }

    async fn until_entered(&self, count: usize) {
        tokio::time::timeout(WAIT, async {
            while self.entered() < count {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("handlers entered in time");
    }

    /// `GET|POST /block` waits for the gate, then counts a side effect.
    /// `GET /big/:kib` answers that many KiB of octets at once.
    fn router(&self) -> axum::Router {
        use axum::routing::get;
        let gate = self.clone();
        let blocked = move || {
            let gate = gate.clone();
            async move {
                gate.entered
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _pass = gate.open.acquire().await.unwrap();
                gate.finished
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                "done"
            }
        };
        axum::Router::new()
            .route("/block", get(blocked.clone()).post(blocked))
            .route(
                "/big/:kib",
                get(
                    |axum::extract::Path(kib): axum::extract::Path<usize>| async move {
                        (
                            [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
                            vec![7u8; kib * 1024],
                        )
                    },
                ),
            )
    }
}

fn limits(per_connection: usize, total: usize) -> Limits {
    Limits {
        requests_per_connection: per_connection,
        requests: total,
        ..Limits::default()
    }
}

/// Replies by request id, skipping stream replies.
async fn replies(device: &mut Device, count: usize) -> std::collections::HashMap<String, Value> {
    let mut found = std::collections::HashMap::new();
    while found.len() < count {
        let reply = device.next_text().await;
        found.insert(reply["id"].as_str().unwrap().to_string(), reply);
    }
    found
}

#[tokio::test]
async fn requests_over_the_connection_cap_are_busy_and_never_enter_a_handler() {
    let gate = Gate::new();
    let mut device = device_on(gate.router(), limits(2, 32)).await;
    let mut ids = Vec::new();
    for _ in 0..5 {
        ids.push(
            device
                .send("request", json!({"method": "GET", "path": "/block"}))
                .await,
        );
    }
    let refused = replies(&mut device, 3).await;
    for id in &ids[2..] {
        assert_eq!(
            refused[id]["error"]["code"], "runtime_busy",
            "{:?}",
            refused[id]
        );
    }
    gate.until_entered(2).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        gate.entered(),
        2,
        "handler entries, not queue occupancy, are capped"
    );

    gate.release();
    let answered = replies(&mut device, 2).await;
    for id in &ids[..2] {
        assert_eq!(answered[id]["result"]["status"], 200);
    }
    // The slots came back with the replies.
    let again = device.request("GET", "/block", json!({})).await;
    assert_eq!(again["status"], 200);
}

#[tokio::test]
async fn requests_over_the_server_cap_are_busy_across_connections() {
    let gate = Gate::new();
    let mut first = device_on(gate.router(), limits(3, 4)).await;
    let dispatcher = first.hub.dispatcher().clone();
    let (tx, mut second_outbound) = mpsc::channel(64);
    let second = dispatcher.session(
        DeviceGrant {
            device_id: first.device_id,
            token: TOKEN.into(),
            revision: 1,
            is_ticket: false,
        },
        tx,
    );
    let declare = json!({"id": "d", "deviceToken": TOKEN, "method": "runtime.clientCapabilities.update",
        "params": {"clientCapabilities": [], "apiGeneration": 1}});
    dispatcher
        .on_text(&second, declare.to_string().as_bytes())
        .await;
    second_outbound.recv().await.unwrap();

    for _ in 0..3 {
        first
            .send("request", json!({"method": "GET", "path": "/block"}))
            .await;
    }
    gate.until_entered(3).await;
    for index in 0..2 {
        let envelope = json!({"id": format!("s{index}"), "deviceToken": TOKEN, "method": "request",
            "params": {"method": "GET", "path": "/block"}});
        dispatcher
            .on_text(&second, envelope.to_string().as_bytes())
            .await;
    }
    let reply = match second_outbound.recv().await.unwrap().frame {
        Outbound::Text(text) => serde_json::from_str::<Value>(&text).unwrap(),
        Outbound::Binary(_) => panic!("expected text"),
    };
    assert_eq!(reply["id"], "s1");
    assert_eq!(reply["error"]["code"], "runtime_busy");
    gate.until_entered(4).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(gate.entered(), 4);
    gate.release();
}

/// A connection that ends (closed or revoked) cancels its requests: one
/// blocked before its side effect never performs it once released.
#[tokio::test]
async fn closing_a_connection_cancels_its_blocked_requests() {
    let gate = Gate::new();
    let mut device = device_on(gate.router(), limits(2, 2)).await;
    device
        .send("request", json!({"method": "POST", "path": "/block"}))
        .await;
    device
        .send("request", json!({"method": "GET", "path": "/block"}))
        .await;
    gate.until_entered(2).await;

    device.link.revoke(device.device_id).unwrap();
    device.session.close();
    tokio::time::timeout(WAIT, device.session.requests_ended())
        .await
        .expect("the request tasks ended");
    gate.release();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        gate.finished(),
        0,
        "no side effect after the connection ended"
    );
    assert!(
        device.outbound.try_recv().is_err(),
        "no reply after the connection ended"
    );

    // Both server-wide slots were given back: a new connection gets one.
    let (tx, mut outbound) = mpsc::channel(8);
    let dispatcher = device.hub.dispatcher().clone();
    let next = dispatcher.session(
        DeviceGrant {
            device_id: device.device_id,
            token: TOKEN.into(),
            revision: 1,
            is_ticket: false,
        },
        tx,
    );
    for envelope in [
        json!({"id": "d", "deviceToken": TOKEN, "method": "runtime.clientCapabilities.update",
            "params": {"clientCapabilities": [], "apiGeneration": 1}}),
        json!({"id": "r", "deviceToken": TOKEN, "method": "request",
            "params": {"method": "GET", "path": "/block"}}),
    ] {
        dispatcher
            .on_text(&next, envelope.to_string().as_bytes())
            .await;
    }
    for expected in ["d", "r"] {
        let frame = tokio::time::timeout(WAIT, outbound.recv())
            .await
            .unwrap()
            .unwrap()
            .frame;
        let Outbound::Text(text) = frame else {
            panic!("expected text")
        };
        let reply: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(reply["id"], expected);
        assert_eq!(reply["ok"], true, "{reply}");
    }
}

/// A change waiting behind other frames rechecks the standing before its
/// handler: a registry revoke in between stops it; reads are unaffected.
#[tokio::test]
async fn a_change_rechecks_the_standing_before_its_handler() {
    let gate = Gate::new();
    gate.release();
    let mut device = device_on(gate.router(), limits(4, 4)).await;
    device.link.rotate_token(device.device_id, &"ee".repeat(24));
    let refused = device
        .call("request", json!({"method": "POST", "path": "/block"}))
        .await;
    assert_eq!(refused["error"]["code"], "unauthorized", "{refused}");
    assert_eq!(gate.entered(), 0);
}

#[tokio::test]
async fn a_request_past_its_deadline_fails_and_frees_its_slot() {
    let gate = Gate::new();
    let mut device = device_on(
        gate.router(),
        Limits {
            request_deadline: Duration::from_millis(150),
            ..limits(1, 1)
        },
    )
    .await;
    let late = device
        .call("request", json!({"method": "GET", "path": "/block"}))
        .await;
    assert_eq!(late["error"]["code"], "deadline_exceeded", "{late}");
    gate.release();
    let next = device.request("GET", "/block", json!({})).await;
    assert_eq!(next["status"], 200);
}

/// Replies wait for room in the connection's queued-byte budget instead of
/// piling up in memory behind a slow socket.
#[tokio::test]
async fn queued_reply_bytes_stay_within_the_connection_budget() {
    let gate = Gate::new();
    let budget = 1024 * 1024;
    let mut device = device_on(
        gate.router(),
        Limits {
            queued_bytes_per_connection: budget,
            ..limits(8, 8)
        },
    )
    .await;
    // Each reply is one binary chunk of a little under 400 KiB.
    for _ in 0..5 {
        device
            .send("request", json!({"method": "GET", "path": "/big/380"}))
            .await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let queued = device.session.queued_bytes();
    assert!(
        queued <= budget,
        "{queued} bytes queued over a {budget} budget"
    );
    assert!(queued >= 2 * 380 * 1024, "the budget is used: {queued}");
    for _ in 0..5 {
        let (first, body) = device.binary_reply().await;
        assert_eq!(first["result"]["status"], 200);
        assert_eq!(body.len(), 380 * 1024);
    }
    assert_eq!(device.session.queued_bytes(), 0);
}

/// Over the socket: a phone revoked while its change waits in a handler
/// never gets the change made, once the handler is released.
#[tokio::test]
async fn revoking_a_phone_with_a_blocked_change_makes_no_change() {
    let gate = Gate::new();
    let server = listening_with(HubConfig {
        router: Some(gate.router()),
        ..quiet_config()
    })
    .await;
    let mut phone = connect_phone(server.port, TOKEN).await.unwrap();
    phone
        .call(
            "runtime.clientCapabilities.update",
            json!({"clientCapabilities": [], "apiGeneration": 1}),
        )
        .await;
    phone
        .send_rpc("request", json!({"method": "POST", "path": "/block"}))
        .await;
    gate.until_entered(1).await;

    server.link.revoke(server.device_id).unwrap();
    server.hub.disconnect(server.device_id);
    assert_eq!(close_code(&mut phone.socket).await, None, "terminated");
    tokio::time::sleep(Duration::from_millis(100)).await;
    gate.release();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(gate.finished(), 0);
}

/// A phone that only receives (it answers pings but sends no frames) stops
/// receiving once its credential leaves the registry, even when nobody told
/// this server's connection table.
#[tokio::test]
async fn a_receive_only_subscription_stops_when_the_registry_drops_the_device() {
    let server = listening(
        Caps::default(),
        Timing {
            standing_recheck: Duration::ZERO,
            ..fast_timing()
        },
    )
    .await;
    let project = server.app.project("repo").await;
    let mut phone = connect_phone(server.port, TOKEN).await.unwrap();
    phone
        .call(
            "runtime.clientCapabilities.update",
            json!({"clientCapabilities": [], "apiGeneration": 1}),
        )
        .await;
    phone
        .send_rpc(
            "subscribe",
            json!({"stream": "/streams/tasks", "params": {"project_id": project.id}}),
        )
        .await;
    let ready = phone.reply().await;
    assert_eq!(ready["result"]["type"], "ready", "{ready}");
    let snapshot = phone.reply().await;
    assert_eq!(snapshot["result"]["type"], "message", "{snapshot}");
    // Take whatever the stream sent before the credential changes: read
    // until 300 ms pass without an application frame (pings keep coming).
    let mut quiet_since = tokio::time::Instant::now();
    while quiet_since.elapsed() < Duration::from_millis(300) {
        if let Ok(Some(Ok(Message::Text(_) | Message::Binary(_)))) =
            tokio::time::timeout(Duration::from_millis(50), phone.socket.next()).await
        {
            quiet_since = tokio::time::Instant::now();
        }
    }

    server.link.rotate_token(server.device_id, &"ee".repeat(24));
    server
        .app
        .task(&project, "After the credential changed")
        .await;
    // Reading answers the server's pings; no application frame may arrive.
    loop {
        let message = tokio::time::timeout(WAIT, phone.socket.next())
            .await
            .expect("the server ends the connection")
            .expect("open")
            .expect("readable");
        match message {
            Message::Close(frame) => {
                assert_eq!(frame.map(|frame| u16::from(frame.code)), Some(4001));
                break;
            }
            Message::Text(_) | Message::Binary(_) => panic!("a frame reached a revoked phone"),
            _ => continue,
        }
    }
}

/// A peer that stops reading: the writer's stuck write is bounded, and once
/// the connection ends no writer task outlives it.
#[tokio::test]
async fn a_writer_stuck_on_a_peer_that_never_reads_is_aborted_and_joined() {
    let gate = Gate::new();
    let server = listening_with(HubConfig {
        timing: Timing {
            close_grace: Duration::from_millis(200),
            ..Timing::default()
        },
        limits: limits(16, 16),
        router: Some(gate.router()),
        ..quiet_config()
    })
    .await;
    let mut phone = connect_phone(server.port, TOKEN).await.unwrap();
    phone
        .call(
            "runtime.clientCapabilities.update",
            json!({"clientCapabilities": [], "apiGeneration": 1}),
        )
        .await;
    for _ in 0..12 {
        phone
            .send_rpc("request", json!({"method": "GET", "path": "/big/8000"}))
            .await;
    }
    // Let the socket buffers fill, then leave without reading.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(server.hub.table().writers(), 1);
    phone.socket.send(Message::Close(None)).await.unwrap();
    tokio::time::timeout(WAIT, async {
        while server.hub.table().writers() > 0
            || server.hub.table().connections_of(server.device_id) > 0
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the writer is gone with its connection");
}

#[tokio::test]
async fn a_write_that_never_completes_ends_the_connection() {
    let gate = Gate::new();
    let server = listening_with(HubConfig {
        timing: Timing {
            write_timeout: Duration::from_millis(300),
            ..Timing::default()
        },
        limits: limits(16, 16),
        router: Some(gate.router()),
        ..quiet_config()
    })
    .await;
    let mut phone = connect_phone(server.port, TOKEN).await.unwrap();
    phone
        .call(
            "runtime.clientCapabilities.update",
            json!({"clientCapabilities": [], "apiGeneration": 1}),
        )
        .await;
    for _ in 0..12 {
        phone
            .send_rpc("request", json!({"method": "GET", "path": "/big/8000"}))
            .await;
    }
    tokio::time::timeout(WAIT, async {
        while server.hub.table().writers() > 0
            || server.hub.table().connections_of(server.device_id) > 0
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the stuck write ended the connection");
}

// ---------------------------------------------------------------------------
// /rpc/mobile/* for the desktop pane.
// ---------------------------------------------------------------------------

pub(super) async fn rpc(
    app: &TestApp,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = routes::api_router(app.state.clone())
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn the_pane_api_is_unavailable_without_a_listener() {
    let app = test_support::app().await;
    for (method, path) in [
        (Method::GET, "/rpc/mobile/interfaces"),
        (Method::GET, "/rpc/mobile/devices"),
    ] {
        let (status, body) = rpc(&app, method, path, None).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"]["code"], "mobile_unavailable");
    }
}

#[tokio::test]
async fn a_loopback_offer_keeps_the_listener_on_loopback() {
    let server = listening(Caps::default(), Timing::default()).await;
    let (status, body) = rpc(
        &server.app,
        Method::POST,
        "/rpc/mobile/pairing-offer",
        Some(json!({"address": "127.0.0.1"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let endpoint = format!("ws://127.0.0.1:{}", server.port);
    assert_eq!(body["endpoint"], endpoint);
    assert_eq!(body["pairingUrl"], format!("chro://pair?code={endpoint}"));
    assert_eq!(body["qrSvg"], "<svg/>");
    assert!(body["expiresAt"].is_u64(), "epoch milliseconds");
    assert_eq!(server.hub.scope(), Some(BindScope::Loopback));
    assert_eq!(server.link.offers(), vec![(endpoint, false)]);
}

#[tokio::test]
async fn a_network_offer_opens_the_same_port_to_the_network() {
    let server = listening(Caps::default(), Timing::default()).await;
    let (status, body) = rpc(
        &server.app,
        Method::POST,
        "/rpc/mobile/pairing-offer",
        Some(json!({"address": "192.168.1.23", "rotate": true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["endpoint"],
        format!("ws://192.168.1.23:{}", server.port)
    );
    assert_eq!(server.hub.scope(), Some(BindScope::Network));
    assert!(server.link.offers()[0].1, "rotate passes through");
    // Loopback still reaches the rebound port.
    connect_phone(server.port, TOKEN)
        .await
        .expect("reachable after rebinding");

    let (status, body) = rpc(
        &server.app,
        Method::POST,
        "/rpc/mobile/pairing-offer",
        Some(json!({"address": "ws://user@host"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_address");
}

fn interfaces_of(list: &[(&str, [u8; 4])]) -> HubConfig {
    let interfaces: Vec<InterfaceAddress> = list
        .iter()
        .map(|(name, ip)| InterfaceAddress {
            name: (*name).into(),
            ip: (*ip).into(),
            netmask: [255, 255, 255, 0].into(),
        })
        .collect();
    HubConfig {
        interfaces: Arc::new(move || interfaces.clone()),
        ..HubConfig::default()
    }
}

#[tokio::test]
async fn the_picker_never_lists_loopback_and_the_default_offer_takes_the_best_address() {
    let server = listening_with(interfaces_of(&[
        ("lo0", [127, 0, 0, 1]),
        ("en0", [192, 168, 1, 23]),
        ("utun4", [100, 101, 102, 103]),
    ]))
    .await;
    let (status, body) = rpc(&server.app, Method::GET, "/rpc/mobile/interfaces", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["addresses"],
        json!([
            {"address": "100.101.102.103", "kind": "tailnet", "label": "utun4"},
            {"address": "192.168.1.23", "kind": "lan", "label": "en0"},
        ])
    );
    let (status, body) = rpc(
        &server.app,
        Method::POST,
        "/rpc/mobile/pairing-offer",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["endpoint"],
        format!("ws://100.101.102.103:{}", server.port)
    );
}

#[tokio::test]
async fn an_offer_with_no_reachable_address_is_refused() {
    let server = listening(Caps::default(), Timing::default()).await;
    let (status, body) = rpc(
        &server.app,
        Method::POST,
        "/rpc/mobile/pairing-offer",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_address");
    assert_eq!(
        body["error"]["message"],
        "No reachable network address is available for pairing. Connect to Wi\u{2011}Fi or Tailscale, or pick an address manually."
    );
    assert!(server.link.offers().is_empty());
    assert_eq!(server.hub.scope(), Some(BindScope::Loopback));
}

#[tokio::test]
async fn custom_addresses_are_validated_and_saved_in_the_desktop_config() {
    let server = listening(Caps::default(), Timing::default()).await;
    let path = "/rpc/mobile/address-preference";
    let (status, body) = rpc(&server.app, Method::GET, path, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({"customAddresses": [], "selectedCustomAddress": null})
    );

    let (status, body) = rpc(
        &server.app,
        Method::PUT,
        path,
        Some(json!({
            "customAddresses": [" mac.tail1234.ts.net ", "https://relay.example.com", "mac.tail1234.ts.net"],
            "selectedCustomAddress": "mac.tail1234.ts.net",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let saved = json!({
        "customAddresses": ["mac.tail1234.ts.net", "https://relay.example.com"],
        "selectedCustomAddress": "mac.tail1234.ts.net",
    });
    assert_eq!(body, saved, "trimmed and without duplicates");
    let (_, body) = rpc(&server.app, Method::GET, path, None).await;
    assert_eq!(body, saved);
    let config = server.app.state.runtime().current_config().await;
    assert_eq!(
        config.mobile_pairing.custom_addresses,
        vec!["mac.tail1234.ts.net", "https://relay.example.com"]
    );
    assert_eq!(
        config.mobile_pairing.selected_custom_address.as_deref(),
        Some("mac.tail1234.ts.net")
    );

    for (preference, fragment) in [
        (
            json!({"customAddresses": ["two words"], "selectedCustomAddress": null}),
            "\"two words\": contains a space",
        ),
        (
            json!({"customAddresses": ["ws://host/path"], "selectedCustomAddress": null}),
            "path",
        ),
        (
            json!({"customAddresses": ["a.example"], "selectedCustomAddress": "b.example"}),
            "\"b.example\" is not one of the custom addresses",
        ),
    ] {
        let (status, body) = rpc(&server.app, Method::PUT, path, Some(preference)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"]["code"], "invalid_address");
        let message = body["error"]["message"].as_str().unwrap();
        assert!(message.contains(fragment), "{message}");
    }
    let (_, body) = rpc(&server.app, Method::GET, path, None).await;
    assert_eq!(body, saved, "a refused change keeps what was saved");

    let too_many: Vec<String> = (0..=super::routes::MAX_CUSTOM_ADDRESSES)
        .map(|n| format!("host{n}.example"))
        .collect();
    let (status, body) = rpc(
        &server.app,
        Method::PUT,
        path,
        Some(json!({"customAddresses": too_many, "selectedCustomAddress": null})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[tokio::test]
async fn an_offer_without_an_address_uses_the_selected_custom_address() {
    let server = listening_with(interfaces_of(&[("en0", [192, 168, 1, 23])])).await;
    let (status, body) = rpc(
        &server.app,
        Method::PUT,
        "/rpc/mobile/address-preference",
        Some(json!({
            "customAddresses": ["mac.tail1234.ts.net:7443"],
            "selectedCustomAddress": "mac.tail1234.ts.net:7443",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = rpc(
        &server.app,
        Method::POST,
        "/rpc/mobile/pairing-offer",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["endpoint"], "ws://mac.tail1234.ts.net:7443");
    assert_eq!(
        body["pairingUrl"], "chro://pair?code=ws://mac.tail1234.ts.net:7443",
        "the code carries the custom endpoint"
    );
    assert_eq!(server.hub.scope(), Some(BindScope::Network));

    // A hostname without a port gets the listener's port.
    let (_, body) = rpc(
        &server.app,
        Method::POST,
        "/rpc/mobile/pairing-offer",
        Some(json!({"address": "mac.tail1234.ts.net"})),
    )
    .await;
    assert_eq!(
        body["endpoint"],
        format!("ws://mac.tail1234.ts.net:{}", server.port)
    );
}

#[tokio::test]
async fn a_phone_paired_over_the_network_reopens_the_listener_on_start() {
    let app = test_support::app().await;
    let link = FakeLink::default();
    link.pair_from(TOKEN, SourceClass::Tailnet);
    let hub = MobileHub::new(app.state.clone(), Arc::new(link), quiet_config());
    hub.open(TcpListener::bind("127.0.0.1:0").await.unwrap())
        .await
        .unwrap();
    assert_eq!(hub.scope(), Some(BindScope::Network));

    let local_only = FakeLink::default();
    local_only.pair_from(TOKEN, SourceClass::Loopback);
    let hub = MobileHub::new(app.state.clone(), Arc::new(local_only), quiet_config());
    hub.open(TcpListener::bind("127.0.0.1:0").await.unwrap())
        .await
        .unwrap();
    assert_eq!(hub.scope(), Some(BindScope::Loopback));
}

#[tokio::test]
async fn start_installs_the_hub_and_remembers_a_fallback_port() {
    let app = test_support::app().await;
    let data_dir = app.dir.path().join("mobile");
    let hub = MobileHub::start(
        app.state.clone(),
        Arc::new(FakeLink::default()),
        &data_dir,
        PortChoice::Planned,
    )
    .await
    .unwrap();
    let port = hub.port().unwrap();
    assert!(Arc::ptr_eq(&app.state.mobile().unwrap(), &hub));
    assert_eq!(hub.scope(), Some(BindScope::Loopback));
    let saved = std::fs::read_to_string(data_dir.join("mobile-ws-fallback-port.json")).ok();
    if port == super::listener::DEFAULT_PORT {
        assert!(saved.is_none(), "the default port is not worth remembering");
    } else {
        assert_eq!(
            serde_json::from_str::<Value>(&saved.unwrap()).unwrap()["port"],
            port
        );
    }
}

#[tokio::test]
async fn devices_list_and_revoke_errors() {
    let server = listening(Caps::default(), Timing::default()).await;
    let (status, body) = rpc(&server.app, Method::GET, "/rpc/mobile/devices", None).await;
    assert_eq!(status, StatusCode::OK);
    let devices = body["devices"].as_array().unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0]["id"], server.device_id.to_string());
    assert_eq!(devices[0]["name"], "Test phone");
    assert!(devices[0]["pairedAt"].is_u64(), "epoch milliseconds");
    assert!(devices[0].get("lastSeenAt").is_none(), "never connected");

    let (status, body) = rpc(
        &server.app,
        Method::DELETE,
        "/rpc/mobile/devices/nope",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_device_id");
    let (status, body) = rpc(
        &server.app,
        Method::DELETE,
        &format!("/rpc/mobile/devices/{}", Uuid::new_v4()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "device_not_found");

    let (status, body) = rpc(&server.app, Method::GET, "/rpc/mobile/interfaces", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["addresses"], json!([]), "the hub's pinned interfaces");
}
