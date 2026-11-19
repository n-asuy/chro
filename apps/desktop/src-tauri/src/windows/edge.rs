//! The screen-edge toolbar: a second window of the same app, docked to the
//! right edge of the screen. It loads the renderer's `/edge` route, so it uses
//! the app's own components and the same `chro-server` as the session windows.
//!
//! The window is frameless, transparent, always on top, on every Space and
//! absent from the Dock/taskbar. It has one fixed frame: a strip along the
//! right edge, as tall as the work area and wide enough for the toolbar plus a
//! panel. It is never resized while the renderer animates, so its CSS motion
//! (the toolbar folding into the tab, panels scaling in) plays unclipped and
//! nothing snaps when a transition starts or ends.
//!
//! Only the visible surfaces take the pointer. The renderer reports their
//! rectangles ([`edge_toolbar_set_hit_regions`]); a poll of the global cursor
//! lets clicks through the window everywhere else and tells the renderer when
//! the pointer enters or leaves a surface (`edge-pointer`), which also works
//! while the app is inactive and the web view gets no mouse moves.
//!
//! Whether the window exists at all is decided by the `edge_toolbar` feature
//! flag, which only the renderer can resolve (developer overrides live in its
//! storage). A session window therefore reports the flag through
//! [`edge_toolbar_set_enabled`]; with the flag off the window is never built.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime as TauriRuntime,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tracing::{debug, warn};

use super::builder::runtime_init_script;
use crate::error::{DesktopError, DesktopResult};
use crate::runtime::server::primary_runtime;

/// Label of the edge toolbar window. Session windows use generated labels.
pub const EDGE_WINDOW_LABEL: &str = "edge";

/// Renderer route the edge window loads.
const EDGE_ROUTE: &str = "edge";

/// Width of the window frame in logical pixels: the toolbar (34 pt, 8 pt from
/// the edge), the 23.5 pt gap, the 343 pt session list with the 300 pt preview
/// 8 pt beside it, and room for their shadows.
const FRAME_WIDTH: f64 = 760.0;

/// How often the cursor is sampled for click-through and hover. On macOS a
/// sample is a CoreGraphics call on the poll thread (no main-thread hop), so
/// it can run at twice the display rate.
const POLL_INTERVAL: Duration = Duration::from_millis(8);

/// Polls between checks that the frame still matches the screen's work area.
const REDOCK_EVERY: u32 = 60;

/// Event telling the renderer whether the pointer is over one of its surfaces.
const POINTER_EVENT: &str = "edge-pointer";

/// Event carrying an Option gesture (see `option_tap`): to the capture window
/// while it is open (its ask field listens), else to the toolbar.
const OPTION_EVENT: &str = "edge-option";

/// An axis-aligned rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// A surface that takes the pointer, in logical pixels from the window's
/// top-left corner, as the renderer lays it out. A region with an `id` is
/// also reported when the pointer is over it (hover, which the web view does
/// not see while the app is inactive).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct HitRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub id: Option<String>,
}

/// What the renderer is told when the pointer moves between its surfaces.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PointerState {
    /// Over any surface (the window takes the pointer).
    pub inside: bool,
    /// The named region under the pointer: the last one in the list, so a
    /// renderer lists the most specific region after the ones containing it.
    pub id: Option<String>,
}

/// Set while a cursor poll runs; a rebuilt window reuses the running one.
static POLLING: AtomicBool = AtomicBool::new(false);

/// The renderer's current hit regions.
#[derive(Default)]
struct HitRegions(Mutex<Vec<HitRegion>>);

/// Whether a window label belongs to the edge toolbar rather than a session
/// window. Code that looks for "the app window" (notifications, deep links,
/// the single-instance handoff, the window menu) must skip it.
pub fn is_edge_window(label: &str) -> bool {
    label == EDGE_WINDOW_LABEL || label == super::edge_capture::CAPTURE_WINDOW_LABEL
}

/// The window's frame: `width` physical pixels against the right edge of
/// `work_area`, the work area's full height.
pub fn docked_frame(work_area: Frame, width: u32) -> Frame {
    let width = width.clamp(1, work_area.width.max(1));
    Frame {
        x: work_area.x + (work_area.width - width) as i32,
        y: work_area.y,
        width,
        height: work_area.height.max(1),
    }
}

fn contains(r: &HitRegion, x: f64, y: f64) -> bool {
    x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
}

/// Whether a point (logical pixels, window-local) lies on a hit region.
pub fn hits(regions: &[HitRegion], x: f64, y: f64) -> bool {
    regions.iter().any(|r| contains(r, x, y))
}

/// The pointer's state at a point: on a surface or not, and which named
/// region it is over.
pub fn pointer_state(regions: &[HitRegion], x: f64, y: f64) -> PointerState {
    PointerState {
        inside: hits(regions, x, y),
        id: regions
            .iter()
            .rev()
            .find(|r| r.id.is_some() && contains(r, x, y))
            .and_then(|r| r.id.clone()),
    }
}

/// The cursor in logical pixels relative to the window's top-left corner,
/// from a cursor and a window position in physical pixels of one desktop (the
/// path used off macOS; macOS reads points directly, see `cursor_points`).
pub fn cursor_in_window(cursor: (f64, f64), window: (f64, f64), window_scale: f64) -> (f64, f64) {
    (
        (cursor.0 - window.0) / window_scale,
        (cursor.1 - window.1) / window_scale,
    )
}

/// Create or close the edge window to match the flag.
pub async fn set_enabled<R: TauriRuntime>(app: &AppHandle<R>, enabled: bool) -> Result<()> {
    let existing = app.get_webview_window(EDGE_WINDOW_LABEL);
    match (enabled, existing) {
        (true, Some(_)) | (false, None) => Ok(()),
        (false, Some(window)) => window.destroy().context("close edge window"),
        (true, None) => build(app).await,
    }
}

async fn build<R: TauriRuntime>(app: &AppHandle<R>) -> Result<()> {
    let runtime = primary_runtime(app)
        .await
        .context("no runtime for the edge window")?;
    let init_script = runtime_init_script(&runtime, None);
    let builder = WebviewWindowBuilder::new(
        app,
        EDGE_WINDOW_LABEL,
        WebviewUrl::App(EDGE_ROUTE.into()),
    )
    .title("Chro")
    .visible(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focused(false)
    // The first click on the tab must act, not just activate the window.
    .accept_first_mouse(true)
    .disable_drag_drop_handler()
    .initialization_script(&init_script);

    let window = match builder.build() {
        Ok(window) => window,
        // Two session windows can report the flag at the same moment; the
        // loser finds the window already built, which is the desired state.
        Err(_) if app.get_webview_window(EDGE_WINDOW_LABEL).is_some() => return Ok(()),
        Err(err) => return Err(err).context("build edge window"),
    };
    app.manage(HitRegions::default());
    // Nothing takes the pointer until the renderer reports its surfaces.
    window
        .set_ignore_cursor_events(true)
        .context("start edge window click-through")?;
    dock(&window)?;
    show_without_focus(&window)?;
    spawn_pointer_poll(app.clone());
    super::edge_talk::spawn_probe(app.clone());
    Ok(())
}

/// Bring the window on screen without making it key: showing it the usual
/// way takes the keyboard from chro's main window, which would count as
/// chro leaving the front (see `edge_presence`).
fn show_without_focus<R: TauriRuntime>(window: &WebviewWindow<R>) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let ns = window.ns_window().context("edge native window")? as usize;
        window
            .run_on_main_thread(move || {
                // SAFETY: the pointer is the edge window's NSWindow, alive
                // while the window exists; used on the main thread.
                let window = unsafe { &*(ns as *const objc2_app_kit::NSWindow) };
                window.orderFrontRegardless();
            })
            .context("show edge window")?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.show().context("show edge window")
    }
}

/// The frame for the screen the window is on.
fn current_frame<R: TauriRuntime>(window: &WebviewWindow<R>) -> Result<Frame> {
    let monitor = window
        .current_monitor()?
        .or(window.primary_monitor()?)
        .context("no monitor for the edge window")?;
    let area = monitor.work_area();
    let work_area = Frame {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    };
    let width = (FRAME_WIDTH * monitor.scale_factor()).round() as u32;
    Ok(docked_frame(work_area, width))
}

/// Place the window on its frame.
fn dock<R: TauriRuntime>(window: &WebviewWindow<R>) -> Result<Frame> {
    let frame = current_frame(window)?;
    window.set_size(PhysicalSize::new(frame.width, frame.height))?;
    window.set_position(PhysicalPosition::new(frame.x, frame.y))?;
    Ok(frame)
}

/// The top-left corner of a frame in points (global, top-left origin), the
/// space the CoreGraphics cursor location is in.
pub fn frame_origin_points(frame: Frame, scale: f64) -> (f64, f64) {
    (f64::from(frame.x) / scale, f64::from(frame.y) / scale)
}

/// One sample of the session's input state, read on the calling thread: the
/// cursor (points, global, top-left origin) and the keyboard. Reading the
/// modifier flags and the key-down counter needs no privacy permission (unlike
/// an event tap or a global key monitor), so the gesture works for every user.
#[cfg(target_os = "macos")]
struct InputSample {
    cursor: (f64, f64),
    keys: super::option_tap::KeyState,
}

#[cfg(target_os = "macos")]
fn input_sample() -> Option<InputSample> {
    use core_graphics::event::{CGEvent, CGEventFlags};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
    }
    /// `kCGEventSourceStateCombinedSessionState` and `kCGEventKeyDown`.
    const COMBINED_SESSION_STATE: i32 = 0;
    const KEY_DOWN: u32 = 10;

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let event = CGEvent::new(source).ok()?;
    let point = event.location();
    let flags = event.get_flags();
    let others = CGEventFlags::CGEventFlagShift
        | CGEventFlags::CGEventFlagControl
        | CGEventFlags::CGEventFlagCommand;
    // SAFETY: a pure query of the window server's event counters.
    let key_downs = unsafe { CGEventSourceCounterForEventType(COMBINED_SESSION_STATE, KEY_DOWN) };
    Some(InputSample {
        cursor: (point.x, point.y),
        keys: super::option_tap::KeyState {
            option: flags.contains(CGEventFlags::CGEventFlagAlternate),
            other_modifier: flags.intersects(others),
            key_downs: u64::from(key_downs),
        },
    })
}

/// Sample the cursor until the window closes: let clicks through outside the
/// hit regions, report entering and leaving them, and re-dock when the work
/// area changes (a display or the Dock moved).
fn spawn_pointer_poll<R: TauriRuntime>(app: AppHandle<R>) {
    if POLLING.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        debug!("[edge] pointer poll started");
        let mut last: Option<PointerState> = None;
        #[cfg(target_os = "macos")]
        let mut gestures = super::option_tap::OptionGestures::default();
        let started = std::time::Instant::now();
        let mut docked: Option<Frame> = None;
        let mut origin: Option<(f64, f64)> = None;
        let mut tick: u32 = 0;
        while let Some(window) = app.get_webview_window(EDGE_WINDOW_LABEL) {
            if tick % REDOCK_EVERY == 0 {
                match current_frame(&window) {
                    Ok(frame) if docked != Some(frame) => {
                        if let Err(err) = dock(&window) {
                            warn!("[edge] dock failed: {err:#}");
                        }
                        docked = Some(frame);
                        origin = window
                            .scale_factor()
                            .ok()
                            .map(|scale| frame_origin_points(frame, scale));
                    }
                    Ok(_) => {}
                    Err(err) => warn!("[edge] frame lookup failed: {err:#}"),
                }
            }
            tick = tick.wrapping_add(1);

            #[cfg(target_os = "macos")]
            let sample = input_sample();
            #[cfg(target_os = "macos")]
            if let Some(sample) = &sample {
                let now_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
                let listening = super::edge_talk::listening();
                // Sampled always (so a press is tracked across the change),
                // acted on only while the toolbar is shown: with chro's own
                // window in front the gestures have nothing to do here.
                let gesture = gestures.sample(now_ms, sample.keys, listening);
                if let Some(gesture) = gesture.filter(|_| !super::edge_presence::edge_hidden()) {
                    debug!("[edge] option gesture {gesture:?}");
                    let target = app
                        .get_webview_window(super::edge_capture::CAPTURE_WINDOW_LABEL)
                        .unwrap_or_else(|| window.clone());
                    if let Err(err) = target.emit_to(target.label(), OPTION_EVENT, gesture) {
                        warn!("[edge] option event failed: {err:#}");
                    }
                }
            }
            #[cfg(target_os = "macos")]
            let cursor = sample.map(|s| s.cursor);
            #[cfg(not(target_os = "macos"))]
            let cursor = None;
            #[cfg(not(target_os = "macos"))]
            let _ = started;

            if let Some(now) = pointer_at(&app, &window, origin, cursor) {
                if last.as_ref() != Some(&now) {
                    debug!("[edge] pointer inside={} id={:?}", now.inside, now.id);
                    let inside_changed = last.as_ref().map(|s| s.inside) != Some(now.inside);
                    if inside_changed {
                        if let Err(err) = window.set_ignore_cursor_events(!now.inside) {
                            warn!("[edge] click-through toggle failed: {err:#}");
                        }
                    }
                    if let Err(err) = window.emit(POINTER_EVENT, &now) {
                        warn!("[edge] pointer event failed: {err:#}");
                    }
                    last = Some(now);
                }
            }
            thread::sleep(POLL_INTERVAL);
        }
        POLLING.store(false, Ordering::SeqCst);
    });
}

/// The pointer's state over the renderer's regions; `None` when the cursor
/// cannot be read. On macOS it is read on this thread against the docked origin.
#[cfg(target_os = "macos")]
fn pointer_at<R: TauriRuntime>(
    app: &AppHandle<R>,
    _window: &WebviewWindow<R>,
    origin: Option<(f64, f64)>,
    cursor: Option<(f64, f64)>,
) -> Option<PointerState> {
    // Stepped aside: nothing takes the pointer.
    if super::edge_presence::edge_hidden() {
        return Some(PointerState { inside: false, id: None });
    }
    let (ox, oy) = origin?;
    let (cx, cy) = cursor?;
    let regions = app.try_state::<HitRegions>()?;
    let regions = regions.0.lock().ok()?;
    Some(pointer_state(&regions, cx - ox, cy - oy))
}

/// The pointer's state over the renderer's regions; `None` when the cursor
/// cannot be read.
#[cfg(not(target_os = "macos"))]
fn pointer_at<R: TauriRuntime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    _origin: Option<(f64, f64)>,
    _cursor: Option<(f64, f64)>,
) -> Option<PointerState> {
    // Stepped aside: nothing takes the pointer.
    if super::edge_presence::edge_hidden() {
        return Some(PointerState { inside: false, id: None });
    }
    let cursor = app.cursor_position().ok()?;
    let position = window.outer_position().ok()?;
    let window_scale = window.scale_factor().ok()?;
    let (x, y) = cursor_in_window(
        (cursor.x, cursor.y),
        (f64::from(position.x), f64::from(position.y)),
        window_scale,
    );
    let regions = app.try_state::<HitRegions>()?;
    let regions = regions.0.lock().ok()?;
    Some(pointer_state(&regions, x, y))
}

/// Reported by a session window whenever the `edge_toolbar` flag resolves.
#[tauri::command]
pub async fn edge_toolbar_set_enabled<R: TauriRuntime>(
    app: AppHandle<R>,
    enabled: bool,
) -> DesktopResult<()> {
    set_enabled(&app, enabled).await.map_err(DesktopError::from)
}

/// Reported by the edge window whenever its visible surfaces change.
#[tauri::command]
pub fn edge_toolbar_set_hit_regions<R: TauriRuntime>(
    app: AppHandle<R>,
    regions: Vec<HitRegion>,
) -> DesktopResult<()> {
    debug!("[edge] hit regions {regions:?}");
    if let Some(state) = app.try_state::<HitRegions>() {
        if let Ok(mut current) = state.0.lock() {
            *current = regions;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Frame = Frame {
        x: 0,
        y: 25,
        width: 1440,
        height: 875,
    };

    #[test]
    fn docks_against_the_right_edge_at_full_work_area_height() {
        let frame = docked_frame(SCREEN, 1000);
        assert_eq!(frame.x + frame.width as i32, 1440);
        assert_eq!((frame.y, frame.height), (25, 875));
        assert_eq!(frame.width, 1000);
    }

    #[test]
    fn a_frame_wider_than_the_screen_is_clamped_inside_it() {
        let frame = docked_frame(SCREEN, 4000);
        assert_eq!((frame.x, frame.width), (0, 1440));
    }

    #[test]
    fn docks_on_a_secondary_screen_to_the_left_of_the_primary() {
        let left = Frame {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let frame = docked_frame(left, 1000);
        assert_eq!(frame.x, -1000);
        assert_eq!(frame.height, 1080);
    }

    #[test]
    fn only_points_on_a_region_hit() {
        let regions = [
            HitRegion {
                x: 458.0,
                y: 400.0,
                width: 34.0,
                height: 34.0,
                id: None,
            },
            HitRegion {
                x: 44.0,
                y: 400.0,
                width: 390.0,
                height: 600.0,
                id: None,
            },
        ];
        assert!(hits(&regions, 470.0, 410.0));
        assert!(hits(&regions, 44.0, 999.5));
        assert!(!hits(&regions, 440.0, 410.0), "the gap between panel and toolbar");
        assert!(!hits(&regions, 492.0, 410.0), "right edges are exclusive");
        assert!(!hits(&[], 0.0, 0.0));
    }

    #[test]
    fn reports_the_most_specific_named_region_under_the_pointer() {
        let region = |x, y, w, h, id: Option<&str>| HitRegion {
            x,
            y,
            width: w,
            height: h,
            id: id.map(str::to_owned),
        };
        let regions = [
            region(100.0, 100.0, 343.0, 400.0, Some("list")),
            region(106.0, 120.0, 331.0, 32.0, Some("row:a")),
            region(458.0, 400.0, 42.0, 100.0, None),
        ];
        assert_eq!(
            pointer_state(&regions, 200.0, 130.0),
            PointerState {
                inside: true,
                id: Some("row:a".into())
            }
        );
        assert_eq!(
            pointer_state(&regions, 200.0, 300.0).id.as_deref(),
            Some("list")
        );
        assert_eq!(
            pointer_state(&regions, 470.0, 450.0),
            PointerState {
                inside: true,
                id: None
            }
        );
        assert!(!pointer_state(&regions, 10.0, 10.0).inside);
    }

    #[test]
    fn converts_the_cursor_to_window_coordinates() {
        // Window at logical (940, 33) on a 2x screen, cursor at logical (1000, 433).
        let (x, y) = cursor_in_window((2000.0, 866.0), (1880.0, 66.0), 2.0);
        assert!((x - 60.0).abs() < 1e-9 && (y - 400.0).abs() < 1e-9);
    }

    #[test]
    fn a_frame_origin_in_points_is_its_physical_corner_over_the_scale() {
        let frame = Frame {
            x: 2456,
            y: 66,
            width: 1000,
            height: 2168,
        };
        assert_eq!(frame_origin_points(frame, 2.0), (1228.0, 33.0));
    }

    #[test]
    fn only_the_edge_labels_are_edge_windows() {
        assert!(is_edge_window(EDGE_WINDOW_LABEL));
        assert!(is_edge_window(super::super::edge_capture::CAPTURE_WINDOW_LABEL));
        assert!(!is_edge_window("window-3f2a"));
    }
}
