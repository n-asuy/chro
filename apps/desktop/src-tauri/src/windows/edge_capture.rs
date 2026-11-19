//! Region capture ("point at it"): a transparent window over the whole screen
//! the pointer is on, where the person drags out a region and then says what
//! should happen with it. The window loads the renderer's `/edge/capture`
//! route; once a region is picked, the renderer asks for its screenshot,
//! taken by the system's screen capture with the toolbar and this window left
//! out.

use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime as TauriRuntime, WebviewUrl, WebviewWindowBuilder};

use super::builder::runtime_init_script;
use super::privacy::{access, request, Access, Privacy};
use crate::error::{DesktopError, DesktopResult};
use crate::runtime::server::primary_runtime;

/// Label of the capture window.
pub const CAPTURE_WINDOW_LABEL: &str = "edge-capture";

/// Renderer route the capture window loads.
const CAPTURE_ROUTE: &str = "edge/capture";

/// A picked region in points, from the capture window's top-left corner
/// (which is the screen's).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct PickedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// How a start went.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum CaptureStart {
    Started,
    /// Screen Recording is off; the renderer offers its System Settings pane.
    Blocked { privacy: Privacy },
    Unavailable { reason: String },
}

/// The screen the capture window covers, set when it opens.
#[derive(Default)]
struct CaptureScreen(Mutex<Option<ScreenInfo>>);

#[derive(Debug, Clone, Copy)]
struct ScreenInfo {
    /// The display's id, to pick it among the capturable ones.
    display_id: u32,
    /// Its pixels per point.
    scale: f64,
    /// Window numbers to leave out of the screenshot.
    excluded: [u32; 2],
}

/// The pixel size of a region on a screen of `scale` pixels per point.
pub fn pixel_size(rect: PickedRect, scale: f64) -> (usize, usize) {
    let px = |v: f64| (v * scale).round().max(1.0) as usize;
    (px(rect.width), px(rect.height))
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::{Arc, Mutex};

    use anyhow::{anyhow, Result};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSScreen, NSWindow};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::CGImage;
    use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSString};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow,
    };

    use super::{pixel_size, PickedRect, ScreenInfo};

    /// Window level above the menu bar (the pop-up menu level).
    const ABOVE_MENU_BAR: isize = 101;

    pub fn supported() -> bool {
        super::super::privacy::load_framework("ScreenCaptureKit")
            && objc2::runtime::AnyClass::get(c"SCScreenshotManager").is_some()
    }

    /// The window under `ns_window`, as AppKit's.
    unsafe fn window<'a>(ns_window: *mut std::ffi::c_void) -> &'a NSWindow {
        unsafe { &*ns_window.cast::<NSWindow>() }
    }

    /// Cover the screen under the pointer, above the menu bar. Main thread.
    /// Returns that screen's id and scale and the window's number.
    pub fn cover_pointer_screen(ns_window: *mut std::ffi::c_void) -> Result<(u32, f64, u32)> {
        let mtm = MainThreadMarker::new().ok_or_else(|| anyhow!("not on the main thread"))?;
        let mouse = NSEvent::mouseLocation();
        let screens = NSScreen::screens(mtm);
        let screen = screens
            .iter()
            .find(|screen| {
                let f = screen.frame();
                mouse.x >= f.origin.x
                    && mouse.x < f.origin.x + f.size.width
                    && mouse.y >= f.origin.y
                    && mouse.y < f.origin.y + f.size.height
            })
            .or_else(|| NSScreen::mainScreen(mtm))
            .ok_or_else(|| anyhow!("no screen"))?;
        let key = NSString::from_str("NSScreenNumber");
        let display_id = screen
            .deviceDescription()
            .objectForKey(&key)
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .map(|number| number.unsignedIntValue())
            .ok_or_else(|| anyhow!("no display id for the screen"))?;
        let window = unsafe { window(ns_window) };
        window.setFrame_display(screen.frame(), true);
        window.setLevel(ABOVE_MENU_BAR);
        Ok((display_id, screen.backingScaleFactor(), window.windowNumber() as u32))
    }

    /// A window's number. Main thread.
    pub fn window_number(ns_window: *mut std::ffi::c_void) -> u32 {
        unsafe { window(ns_window) }.windowNumber() as u32
    }

    type Reply = Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<Vec<u8>>>>>>;

    fn answer(reply: &Reply, result: Result<Vec<u8>>) {
        if let Some(tx) = reply.lock().ok().and_then(|mut tx| tx.take()) {
            let _ = tx.send(result);
        }
    }

    fn error_text(error: *mut NSError) -> String {
        unsafe { error.as_ref() }
            .map(|e| e.localizedDescription().to_string())
            .unwrap_or_else(|| "unknown error".into())
    }

    fn png(image: &CGImage) -> Result<Vec<u8>> {
        let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), image);
        let data = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
        }
        .ok_or_else(|| anyhow!("encode the screenshot"))?;
        Ok(data.to_vec())
    }

    /// The PNG of `rect` on the screen, without the excluded windows.
    pub async fn screenshot(screen: ScreenInfo, rect: PickedRect) -> Result<Vec<u8>> {
        let rx = start_screenshot(screen, rect);
        rx.await.map_err(|_| anyhow!("capture the region: no answer"))?
    }

    /// Start the capture. The blocks live only here (the system keeps its own
    /// copies), so the caller's future stays sendable.
    fn start_screenshot(
        screen: ScreenInfo,
        rect: PickedRect,
    ) -> tokio::sync::oneshot::Receiver<Result<Vec<u8>>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let reply: Reply = Arc::new(Mutex::new(Some(tx)));
        let on_content = {
            let reply = reply.clone();
            RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
                let Some(content) = (unsafe { content.as_ref() }) else {
                    return answer(&reply, Err(anyhow!("list the screen: {}", error_text(error))));
                };
                let displays = unsafe { content.displays() };
                let Some(display) = displays
                    .iter()
                    .find(|d| unsafe { d.displayID() } == screen.display_id)
                else {
                    return answer(&reply, Err(anyhow!("the screen is no longer there")));
                };
                let excluded: Vec<Retained<SCWindow>> = unsafe { content.windows() }
                    .iter()
                    .filter(|w| screen.excluded.contains(&unsafe { w.windowID() }))
                    .collect();
                let excluded = NSArray::from_retained_slice(&excluded);
                let filter = unsafe {
                    SCContentFilter::initWithDisplay_excludingWindows(
                        SCContentFilter::alloc(),
                        &display,
                        &excluded,
                    )
                };
                let config = unsafe { SCStreamConfiguration::new() };
                let (width, height) = pixel_size(rect, screen.scale);
                unsafe {
                    config.setSourceRect(CGRect::new(
                        CGPoint::new(rect.x, rect.y),
                        CGSize::new(rect.width, rect.height),
                    ));
                    config.setWidth(width);
                    config.setHeight(height);
                    config.setShowsCursor(false);
                }
                let done = {
                    let reply = reply.clone();
                    RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
                        let result = match unsafe { image.as_ref() } {
                            Some(image) => png(image),
                            None => Err(anyhow!("capture the region: {}", error_text(error))),
                        };
                        answer(&reply, result);
                    })
                };
                unsafe {
                    SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                        &filter,
                        &config,
                        Some(&done),
                    );
                }
            })
        };
        unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&on_content) };
        rx
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use anyhow::{bail, Result};

    use super::{PickedRect, ScreenInfo};

    pub fn supported() -> bool {
        false
    }

    pub fn cover_pointer_screen(_ns_window: *mut std::ffi::c_void) -> Result<(u32, f64, u32)> {
        bail!("region capture is available on macOS only")
    }

    pub fn window_number(_ns_window: *mut std::ffi::c_void) -> u32 {
        0
    }

    pub async fn screenshot(_screen: ScreenInfo, _rect: PickedRect) -> Result<Vec<u8>> {
        bail!("region capture is available on macOS only")
    }
}

/// The native window pointer of a webview window (for AppKit calls).
fn ns_window<R: TauriRuntime>(window: &tauri::WebviewWindow<R>) -> Result<usize> {
    #[cfg(target_os = "macos")]
    {
        Ok(window.ns_window().context("native window")? as usize)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        anyhow::bail!("region capture is available on macOS only")
    }
}

async fn open<R: TauriRuntime>(app: &AppHandle<R>) -> Result<()> {
    if let Some(window) = app.get_webview_window(CAPTURE_WINDOW_LABEL) {
        window.set_focus().context("focus the capture window")?;
        return Ok(());
    }
    let runtime = primary_runtime(app).await.context("no runtime for the capture window")?;
    let window = WebviewWindowBuilder::new(app, CAPTURE_WINDOW_LABEL, WebviewUrl::App(CAPTURE_ROUTE.into()))
        .title("Chro")
        .visible(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .disable_drag_drop_handler()
        .initialization_script(runtime_init_script(&runtime, None))
        .build()
        .context("build the capture window")?;
    let capture = ns_window(&window)?;
    let edge = app
        .get_webview_window(super::edge::EDGE_WINDOW_LABEL)
        .map(|edge| ns_window(&edge))
        .transpose()?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let covered = platform::cover_pointer_screen(capture as *mut _).map(|(display_id, scale, own)| {
            let toolbar = edge.map_or(0, |edge| platform::window_number(edge as *mut _));
            ScreenInfo { display_id, scale, excluded: [own, toolbar] }
        });
        let _ = tx.send(covered);
    })
    .context("place the capture window")?;
    let screen = rx.await.context("place the capture window: no answer")??;
    app.manage(CaptureScreen::default());
    if let Some(state) = app.try_state::<CaptureScreen>() {
        *state.0.lock().map_err(|_| anyhow::anyhow!("capture state poisoned"))? = Some(screen);
    }
    window.show().context("show the capture window")?;
    window.set_focus().context("focus the capture window")?;
    Ok(())
}

/// Open the capture window, after asking for Screen Recording if needed.
#[tauri::command]
pub async fn edge_capture_start<R: TauriRuntime>(app: AppHandle<R>) -> DesktopResult<CaptureStart> {
    if !platform::supported() {
        return Ok(CaptureStart::Unavailable {
            reason: "Region capture needs macOS 14 or later.".into(),
        });
    }
    if access(Privacy::ScreenRecording) != Access::Granted {
        // Shows the system's dialog the first time; the answer takes effect
        // after a relaunch, so the note stays until then.
        request(Privacy::ScreenRecording).await;
        tracing::debug!("[edge] capture start blocked by ScreenRecording");
        return Ok(CaptureStart::Blocked { privacy: Privacy::ScreenRecording });
    }
    open(&app).await.map_err(DesktopError::from)?;
    tracing::debug!("[edge] capture start Started");
    Ok(CaptureStart::Started)
}

/// The PNG (base64) of a picked region of the screen the capture window covers.
#[tauri::command]
pub async fn edge_capture_region<R: TauriRuntime>(
    app: AppHandle<R>,
    rect: PickedRect,
) -> DesktopResult<String> {
    use base64::Engine as _;
    let screen = app
        .try_state::<CaptureScreen>()
        .and_then(|state| state.0.lock().ok().and_then(|screen| *screen))
        .ok_or_else(|| DesktopError::from(anyhow::anyhow!("the capture window is not open")))?;
    let png = platform::screenshot(screen, rect).await.map_err(DesktopError::from)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

/// Close the capture window.
#[tauri::command]
pub fn edge_capture_close<R: TauriRuntime>(app: AppHandle<R>) -> DesktopResult<()> {
    if let Some(window) = app.get_webview_window(CAPTURE_WINDOW_LABEL) {
        window.destroy().context("close the capture window").map_err(DesktopError::from)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_region_is_captured_at_the_screens_pixel_density() {
        let rect = PickedRect { x: 10.0, y: 20.0, width: 120.5, height: 40.0 };
        assert_eq!(pixel_size(rect, 2.0), (241, 80));
        assert_eq!(pixel_size(rect, 1.0), (121, 40));
    }

    #[test]
    fn a_region_is_never_empty() {
        let rect = PickedRect { x: 0.0, y: 0.0, width: 0.2, height: 0.0 };
        assert_eq!(pixel_size(rect, 1.0), (1, 1));
    }
}
