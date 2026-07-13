//! Typed CDP payload helpers and the recipes' shared constants.

use serde::{Deserialize, Serialize};

/// URL schemes that are not real user pages. Ported from a reference CDP
/// daemon's internal-scheme list; used to skip the omnibox popup and devtools
/// targets when choosing a page to attach to.
pub const INTERNAL_PREFIXES: &[&str] = &[
    "chrome://",
    "chrome-untrusted://",
    "devtools://",
    "chrome-extension://",
    "about:",
];

/// True if `url` points at an internal Chrome surface rather than a real page.
pub fn is_internal_url(url: &str) -> bool {
    INTERNAL_PREFIXES.iter().any(|p| url.starts_with(p))
}

/// A page target, as reported by `Target.getTargets`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabInfo {
    #[serde(rename = "targetId")]
    pub target_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
}

/// `Page.screencastFrame.metadata` — the geometry needed to map a click on the
/// painted frame back to CSS pixels in the page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreencastMetadata {
    #[serde(rename = "offsetTop", default)]
    pub offset_top: f64,
    #[serde(rename = "pageScaleFactor", default = "one")]
    pub page_scale_factor: f64,
    #[serde(rename = "deviceWidth", default)]
    pub device_width: f64,
    #[serde(rename = "deviceHeight", default)]
    pub device_height: f64,
    #[serde(rename = "scrollOffsetX", default)]
    pub scroll_offset_x: f64,
    #[serde(rename = "scrollOffsetY", default)]
    pub scroll_offset_y: f64,
}

fn one() -> f64 {
    1.0
}

/// A keyboard key resolved to the CDP fields listeners inspect. Ported from a
/// reference CDP daemon's key table: special keys carry their Windows virtual
/// key code and a DOM `code` so `e.key` / `e.keyCode` / `e.code` all fire correctly,
/// and only printable single characters emit a `char` event with text.
pub struct KeyDescriptor {
    pub key: String,
    pub code: String,
    pub windows_virtual_key_code: i64,
    /// Text emitted on `keyDown`/`char`; empty for non-printable keys.
    pub text: String,
}

impl KeyDescriptor {
    /// Resolve a logical key name (`"Enter"`, `"a"`, `"ArrowLeft"`).
    pub fn resolve(key: &str) -> Self {
        if let Some((vk, code, text)) = special_key(key) {
            return Self {
                key: key.to_string(),
                code: code.to_string(),
                windows_virtual_key_code: vk,
                text: text.to_string(),
            };
        }
        // Printable single character: virtual key code from the uppercased
        // ASCII letter/digit; the character itself is the emitted text.
        let chars: Vec<char> = key.chars().collect();
        if chars.len() == 1 {
            let c = chars[0];
            let vk = c.to_ascii_uppercase() as i64;
            Self {
                key: key.to_string(),
                code: key.to_string(),
                windows_virtual_key_code: vk,
                text: key.to_string(),
            }
        } else {
            // Unknown multi-char key: pass through with no text so it is treated
            // as a non-printable named key.
            Self {
                key: key.to_string(),
                code: key.to_string(),
                windows_virtual_key_code: 0,
                text: String::new(),
            }
        }
    }
}

fn special_key(key: &str) -> Option<(i64, &'static str, &'static str)> {
    Some(match key {
        "Enter" => (13, "Enter", "\r"),
        "Tab" => (9, "Tab", "\t"),
        "Backspace" => (8, "Backspace", ""),
        "Escape" => (27, "Escape", ""),
        "Delete" => (46, "Delete", ""),
        " " => (32, "Space", " "),
        "ArrowLeft" => (37, "ArrowLeft", ""),
        "ArrowUp" => (38, "ArrowUp", ""),
        "ArrowRight" => (39, "ArrowRight", ""),
        "ArrowDown" => (40, "ArrowDown", ""),
        "Home" => (36, "Home", ""),
        "End" => (35, "End", ""),
        "PageUp" => (33, "PageUp", ""),
        "PageDown" => (34, "PageDown", ""),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_urls_detected() {
        assert!(is_internal_url("chrome://settings"));
        assert!(is_internal_url("about:blank"));
        assert!(!is_internal_url("https://example.com"));
    }

    #[test]
    fn enter_carries_virtual_key_and_carriage_return() {
        let d = KeyDescriptor::resolve("Enter");
        assert_eq!(d.windows_virtual_key_code, 13);
        assert_eq!(d.code, "Enter");
        assert_eq!(d.text, "\r");
    }

    #[test]
    fn printable_letter_resolves_virtual_key_and_text() {
        let d = KeyDescriptor::resolve("a");
        assert_eq!(d.windows_virtual_key_code, 'A' as i64);
        assert_eq!(d.text, "a");
    }

    #[test]
    fn named_key_has_no_text() {
        let d = KeyDescriptor::resolve("ArrowLeft");
        assert_eq!(d.windows_virtual_key_code, 37);
        assert!(d.text.is_empty());
    }
}
