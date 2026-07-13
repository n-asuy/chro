#[derive(Debug, Clone, Copy)]
pub struct WindowPreset {
    pub width_ratio: f64,
    pub height_ratio: f64,
    pub min_width: u32,
    pub min_height: u32,
    pub min_window_width: u32,
    pub min_window_height: u32,
}

impl WindowPreset {
    /// The one and only window geometry: a resizable session window sized to a
    /// fraction of the work area with a sensible minimum.
    pub const SESSION: WindowPreset = WindowPreset {
        width_ratio: 0.8,
        height_ratio: 0.9,
        min_width: 1280,
        min_height: 800,
        min_window_width: 1100,
        min_window_height: 720,
    };
}

/// Mirror `normalizeRoutePath` from `apps/desktop/electron/main.ts`.
pub fn normalize_route_path(route_path: Option<&str>) -> String {
    let trimmed = route_path.map(|s| s.trim()).filter(|s| !s.is_empty());
    let Some(trimmed) = trimmed else {
        return "/".to_string();
    };
    // Block scheme-like prefixes (e.g. https://) to prevent navigation off-app.
    if trimmed.contains(':') {
        let head = trimmed.split(':').next().unwrap_or("");
        if head
            .chars()
            .next()
            .map(|c| c.is_ascii_alphabetic())
            .unwrap_or(false)
            && head.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return "/".to_string();
        }
    }
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}
