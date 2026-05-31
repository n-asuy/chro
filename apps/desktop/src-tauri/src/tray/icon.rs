use anyhow::{Context, Result};
use base64::Engine;
use once_cell::sync::Lazy;
use tiny_skia::{Pixmap, Transform};
use usvg::{fontdb, Tree};

use super::state::{TrayState, TrayStatus};

const CANVAS_SIZE: u32 = 36;
const OUTPUT_SIZE: u32 = 18;
const BADGE_DIAMETER: f32 = 18.0;
const BADGE_CENTER_OFFSET: f32 = 4.0;

const BASE_ICON_DARWIN: &[u8] = include_bytes!("../../../assets/tray/trayTemplate.png");
const BASE_ICON_OTHER: &[u8] = include_bytes!("../../../assets/tray/tray.png");

static FONT_DB: Lazy<fontdb::Database> = Lazy::new(|| {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    db
});

/// Render the tray icon for the supplied state. Returns RGBA8 bytes plus the
/// width and height, ready to hand to `tauri::image::Image::new`.
pub fn render_tray_image(state: &TrayState) -> Result<(Vec<u8>, u32, u32)> {
    let svg = render_tray_svg(state);
    let opts = usvg::Options {
        fontdb: std::sync::Arc::new(FONT_DB.clone()),
        ..Default::default()
    };
    let tree = Tree::from_str(&svg, &opts).context("parse tray svg")?;

    let mut pixmap = Pixmap::new(CANVAS_SIZE, CANVAS_SIZE).context("alloc tray pixmap")?;
    resvg::render(&tree, Transform::identity(), &mut pixmap.as_mut());

    let scaled = downscale(&pixmap, OUTPUT_SIZE);
    Ok((scaled, OUTPUT_SIZE, OUTPUT_SIZE))
}

fn render_tray_svg(state: &TrayState) -> String {
    // We use `r##"..."##` instead of `r#"..."#` because the SVG payload
    // contains hex color literals like `fill="#3ed470"` whose `"#` byte pair
    // would otherwise terminate a single-hash raw string mid-payload.
    let base_layer = base_layer_svg();
    if state.task_count == 0 {
        return format!(
            r##"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{size}" height="{size}" viewBox="0 0 {size} {size}">
  {base}
</svg>"##,
            size = CANVAS_SIZE,
            base = base_layer
        );
    }

    let fill = match state.status {
        TrayStatus::Connected => "#3ed470",
        TrayStatus::Waiting => "#f5c044",
        TrayStatus::Error => "#ff5a5a",
    };
    let center_x = CANVAS_SIZE as f32 - BADGE_DIAMETER / 2.0 + BADGE_CENTER_OFFSET;
    let center_y = BADGE_DIAMETER / 2.0 - BADGE_CENTER_OFFSET;
    let label = if state.task_count > 999 {
        "1k+".to_string()
    } else if state.task_count > 99 {
        "99+".to_string()
    } else {
        state.task_count.to_string()
    };

    let style = ".badge-label { font-family: \"Noto Sans JP\", \"SF Pro Display\", \"Segoe UI\", sans-serif; font-size: 16px; font-weight: 600; }";
    let mut svg = String::new();
    svg.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    svg.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{s}\" height=\"{s}\" viewBox=\"0 0 {s} {s}\">",
        s = CANVAS_SIZE
    ));
    svg.push_str("<defs><style>");
    svg.push_str(style);
    svg.push_str("</style></defs>");
    svg.push_str(&base_layer);
    svg.push_str("<g>");
    svg.push_str(&format!(
        "<circle cx=\"{cx}\" cy=\"{cy}\" r=\"{r}\" fill=\"{fill}\" />",
        cx = center_x,
        cy = center_y,
        r = BADGE_DIAMETER / 2.0,
        fill = fill
    ));
    svg.push_str(&format!(
        "<text x=\"{cx}\" y=\"{ty}\" text-anchor=\"middle\" dominant-baseline=\"middle\" fill=\"#ffffff\" class=\"badge-label\">{label}</text>",
        cx = center_x,
        ty = center_y + 1.0,
        label = escape_xml(&label)
    ));
    svg.push_str("</g></svg>");
    svg
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn base_layer_svg() -> String {
    let bytes: &[u8] = if cfg!(target_os = "macos") {
        BASE_ICON_DARWIN
    } else {
        BASE_ICON_OTHER
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!(
        r##"<image href="data:image/png;base64,{encoded}" width="{size}" height="{size}" />"##,
        size = CANVAS_SIZE
    )
}

fn downscale(src: &Pixmap, target: u32) -> Vec<u8> {
    let src_data = src.data();
    let src_w = src.width();
    let src_h = src.height();
    let ratio_x = src_w as f32 / target as f32;
    let ratio_y = src_h as f32 / target as f32;
    let mut out = vec![0u8; (target as usize) * (target as usize) * 4];

    for ty in 0..target {
        for tx in 0..target {
            let sx_start = (tx as f32 * ratio_x) as u32;
            let sy_start = (ty as f32 * ratio_y) as u32;
            let sx_end = ((tx + 1) as f32 * ratio_x).ceil() as u32;
            let sy_end = ((ty + 1) as f32 * ratio_y).ceil() as u32;
            let mut acc = [0u32; 4];
            let mut count = 0u32;
            for sy in sy_start..sy_end.min(src_h) {
                for sx in sx_start..sx_end.min(src_w) {
                    let idx = ((sy * src_w + sx) * 4) as usize;
                    acc[0] += src_data[idx] as u32;
                    acc[1] += src_data[idx + 1] as u32;
                    acc[2] += src_data[idx + 2] as u32;
                    acc[3] += src_data[idx + 3] as u32;
                    count += 1;
                }
            }
            let oidx = ((ty * target + tx) * 4) as usize;
            if count > 0 {
                out[oidx] = (acc[0] / count) as u8;
                out[oidx + 1] = (acc[1] / count) as u8;
                out[oidx + 2] = (acc[2] / count) as u8;
                out[oidx + 3] = (acc[3] / count) as u8;
            }
        }
    }
    out
}
