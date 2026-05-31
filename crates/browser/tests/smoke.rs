//! End-to-end smoke test against a real headless Chrome.
//!
//! Ignored by default (needs a Chrome install + spawns a process). Run with:
//!   cargo test --manifest-path crates/browser/Cargo.toml -- --ignored --nocapture
//!
//! Exercises the full path the design relies on: launch a dedicated Chrome,
//! discover the CDP WebSocket, connect, attach to a page, drive a navigation,
//! and pull both a one-shot screenshot and a screencast frame.

use std::time::Duration;

use browser::{Browser, LaunchConfig};

fn temp_profile_base() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("chro-browser-smoke-{}", uuid::Uuid::new_v4()))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires a local Chrome install and launches a browser process"]
async fn launches_navigates_and_streams() {
    let profile = temp_profile_base();
    let browser = Browser::launch(LaunchConfig {
        user_data_dir: profile.clone(),
        headless: true,
        start_url: None,
    })
    .await
    .expect("launch Chrome");

    // Navigate to an inline page so the test needs no network.
    browser
        .navigate("data:text/html,<title>Smoke</title><h1>hello chro</h1>")
        .await
        .expect("navigate");

    // Give the navigation a moment to commit, then confirm the address resolves.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let state = browser.page_state().await.expect("page state");
    assert!(
        state.url.starts_with("data:text/html"),
        "unexpected url: {}",
        state.url
    );

    // One-shot screenshot returns non-empty base64 PNG.
    let shot = browser.capture_screenshot().await.expect("screenshot");
    assert!(!shot.is_empty(), "screenshot was empty");

    // Screencast: start, then expect at least one frame event within a second.
    let mut events = browser.events();
    browser
        .start_screencast(800, 600, 60)
        .await
        .expect("start screencast");

    let mut saw_frame = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
            Ok(Ok(ev)) if ev.method == "Page.screencastFrame" => {
                let data = ev.params.get("data").and_then(|v| v.as_str()).unwrap_or("");
                assert!(!data.is_empty(), "screencast frame had no data");
                let session_id = ev.params.get("sessionId").and_then(|v| v.as_i64());
                if let Some(sid) = session_id {
                    browser.ack_screencast(sid).await.expect("ack");
                }
                saw_frame = true;
                break;
            }
            Ok(Ok(_)) => continue,
            Ok(Err(_)) | Err(_) => continue,
        }
    }
    assert!(saw_frame, "no screencast frame within 3s");

    browser.shutdown();
    let _ = std::fs::remove_dir_all(&profile);
}

/// Proves the input path is a real round trip to Chrome: a full-viewport button
/// rewrites the document title on click. We click via the same `Input.*` CDP
/// commands the pane uses, then read the title back — if it changed, the click
/// reached the live page, not just the canvas.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires a local Chrome install and launches a browser process"]
async fn click_reaches_the_live_page() {
    let profile = temp_profile_base();
    let browser = Browser::launch(LaunchConfig {
        user_data_dir: profile.clone(),
        headless: true,
        start_url: None,
    })
    .await
    .expect("launch Chrome");

    // A button that fills the viewport and renames the document on click.
    browser
        .navigate(
            "data:text/html,<title>before</title>\
             <button style='position:fixed;inset:0;width:100%;height:100%' \
             onclick=\"document.title='after-click'\">hit me</button>",
        )
        .await
        .expect("navigate");
    tokio::time::sleep(Duration::from_millis(800)).await;

    assert_eq!(
        browser.page_state().await.expect("state").title,
        "before",
        "title should start unchanged"
    );

    // Click near the top-left of the viewport — anywhere lands on the button.
    browser
        .click(60.0, 60.0, browser::MouseButton::Left, 1)
        .await
        .expect("click");

    // The onclick handler runs in the page; poll the title until it flips.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    let mut clicked = false;
    while tokio::time::Instant::now() < deadline {
        if matches!(browser.page_state().await, Ok(s) if s.title == "after-click") {
            clicked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        clicked,
        "click never reached the page (title stayed 'before')"
    );

    browser.shutdown();
    let _ = std::fs::remove_dir_all(&profile);
}

/// Regression test for the double-typing bug: pressing keys into a focused
/// input must insert each character exactly once. The page mirrors the input's
/// value into the document title so we can read it back via `page_state`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires a local Chrome install and launches a browser process"]
async fn typing_is_not_doubled() {
    let profile = temp_profile_base();
    let browser = Browser::launch(LaunchConfig {
        user_data_dir: profile.clone(),
        headless: true,
        start_url: None,
    })
    .await
    .expect("launch Chrome");

    // autofocus input; oninput copies the value into document.title.
    browser
        .navigate(
            "data:text/html,<title>empty</title>\
             <input autofocus oninput=\"document.title=this.value||'empty'\">",
        )
        .await
        .expect("navigate");
    tokio::time::sleep(Duration::from_millis(800)).await;

    for ch in ["h", "e", "l", "l", "o"] {
        browser.press_key(ch, 0).await.expect("press");
    }

    // Poll the title until it settles, then assert it equals the typed text
    // exactly — "hheelllloo" would mean the char was inserted twice.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    let mut title = String::new();
    while tokio::time::Instant::now() < deadline {
        title = browser
            .page_state()
            .await
            .map(|s| s.title)
            .unwrap_or_default();
        if title == "hello" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(title, "hello", "typing was doubled or lost");

    browser.shutdown();
    let _ = std::fs::remove_dir_all(&profile);
}
