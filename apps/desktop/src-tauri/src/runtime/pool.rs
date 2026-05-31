use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::windows::WindowMode;

/// Per-window metadata kept by the desktop runtime. The Tauri webview itself
/// is looked up by label via `AppHandle::get_webview_window`, so we keep this
/// struct purely descriptive.
#[derive(Debug, Clone)]
pub struct WindowMeta {
    pub label: String,
    pub runtime_id: String,
    pub workspace_path: Option<String>,
    pub workspace_key: Option<String>,
    pub mode: WindowMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayWorkspaceWindow {
    pub label: String,
    pub display_label: String,
    pub workspace_path: Option<String>,
    pub description: Option<String>,
    pub mode: WindowMode,
    pub is_focused: bool,
}

#[derive(Default)]
pub struct WindowPool {
    windows: Mutex<HashMap<String, WindowMeta>>,
    active_label: Mutex<Option<String>>,
}

impl WindowPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(&self, meta: WindowMeta) {
        self.windows.lock().await.insert(meta.label.clone(), meta);
    }

    pub async fn remove(&self, label: &str) -> Option<WindowMeta> {
        self.windows.lock().await.remove(label)
    }

    pub async fn set_workspace_path(&self, label: &str, workspace_path: Option<String>) {
        if let Some(entry) = self.windows.lock().await.get_mut(label) {
            entry.workspace_key = workspace_path
                .as_deref()
                .and_then(normalize_workspace_path_for_key);
            entry.workspace_path = workspace_path;
        }
    }

    /// Update the tracked mode for a window. Returns `true` only when the mode
    /// actually changed, so callers can apply window geometry exclusively on a
    /// genuine transition. Re-asserting the current mode (e.g. on every route
    /// change) is a no-op and must never re-position a window the user moved.
    pub async fn set_mode(&self, label: &str, mode: WindowMode) -> bool {
        if let Some(entry) = self.windows.lock().await.get_mut(label) {
            if entry.mode == mode {
                return false;
            }
            entry.mode = mode;
            return true;
        }
        false
    }

    pub async fn get(&self, label: &str) -> Option<WindowMeta> {
        self.windows.lock().await.get(label).cloned()
    }

    pub async fn list(&self) -> Vec<WindowMeta> {
        self.windows.lock().await.values().cloned().collect()
    }

    pub async fn set_active(&self, label: Option<String>) {
        *self.active_label.lock().await = label;
    }

    pub async fn active_label(&self) -> Option<String> {
        self.active_label.lock().await.clone()
    }

    /// Find the session window currently hosting the given workspace path.
    pub async fn find_window_for_workspace(&self, workspace_path: &str) -> Option<WindowMeta> {
        let key = normalize_workspace_path_for_key(workspace_path)?;
        let map = self.windows.lock().await;
        map.values()
            .find(|meta| meta.workspace_key.as_deref() == Some(&key))
            .cloned()
    }

    /// Report whether the named runtime is still referenced by any window.
    pub async fn runtime_in_use(&self, runtime_id: &str) -> bool {
        self.windows
            .lock()
            .await
            .values()
            .any(|meta| meta.runtime_id == runtime_id)
    }

    /// Tray menu snapshot: every session window plus a focus marker.
    pub async fn workspace_windows_for_tray(&self) -> Vec<TrayWorkspaceWindow> {
        let active = self.active_label.lock().await.clone();
        let map = self.windows.lock().await;
        let mut entries: Vec<TrayWorkspaceWindow> = map
            .values()
            .filter(|meta| meta.mode == WindowMode::Session)
            .map(|meta| {
                let display_label = meta
                    .workspace_path
                    .as_deref()
                    .and_then(workspace_basename)
                    .unwrap_or_else(|| "Workspace".to_string());
                let description = if meta.workspace_path.is_none() {
                    Some("No workspace selected".to_string())
                } else {
                    None
                };
                let is_focused = active.as_deref() == Some(meta.label.as_str());
                TrayWorkspaceWindow {
                    label: meta.label.clone(),
                    display_label,
                    workspace_path: meta.workspace_path.clone(),
                    description,
                    mode: meta.mode,
                    is_focused,
                }
            })
            .collect();
        entries.sort_by(|a, b| {
            if a.is_focused != b.is_focused {
                return if a.is_focused {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Greater
                };
            }
            a.display_label
                .to_lowercase()
                .cmp(&b.display_label.to_lowercase())
        });
        entries
    }
}

/// Mirror `apps/desktop/electron/main.ts` `normalizeWorkspacePathForKey`. Used
/// to dedup windows by workspace path.
pub fn normalize_workspace_path_for_key(workspace_path: &str) -> Option<String> {
    let trimmed = workspace_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.replace('\\', "/");
    let without_trailing = if normalized == "/" {
        normalized
    } else if normalized.len() == 3 && normalized.ends_with(":/") {
        normalized
    } else {
        normalized.trim_end_matches('/').to_string()
    };
    Some(if cfg!(target_os = "windows") {
        without_trailing.to_lowercase()
    } else {
        without_trailing
    })
}

/// Return the last path component of a workspace path, mirroring
/// `normalizeWorkspaceBasename` in the Electron build.
pub fn workspace_basename(workspace_path: &str) -> Option<String> {
    let normalized = workspace_path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let last = trimmed.rsplit('/').next().unwrap_or(trimmed);
    if last.is_empty() {
        None
    } else {
        Some(last.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(label: &str, mode: WindowMode) -> WindowMeta {
        WindowMeta {
            label: label.to_string(),
            runtime_id: "runtime".to_string(),
            workspace_path: None,
            workspace_key: None,
            mode,
        }
    }

    #[tokio::test]
    async fn set_mode_reports_true_only_on_genuine_transition() {
        let pool = WindowPool::new();
        pool.register(meta("w", WindowMode::Onboarding)).await;

        // Onboarding -> Session is a real transition: geometry should apply.
        assert!(pool.set_mode("w", WindowMode::Session).await);
        assert_eq!(pool.get("w").await.unwrap().mode, WindowMode::Session);
    }

    #[tokio::test]
    async fn set_mode_is_noop_when_already_in_session() {
        // Regression: re-asserting Session on every route change used to return
        // true and re-center the window, clobbering a position the user moved.
        let pool = WindowPool::new();
        pool.register(meta("w", WindowMode::Session)).await;

        assert!(!pool.set_mode("w", WindowMode::Session).await);
    }

    #[tokio::test]
    async fn set_mode_is_noop_when_already_in_onboarding() {
        let pool = WindowPool::new();
        pool.register(meta("w", WindowMode::Onboarding)).await;

        assert!(!pool.set_mode("w", WindowMode::Onboarding).await);
    }

    #[tokio::test]
    async fn set_mode_returns_false_for_unknown_window() {
        let pool = WindowPool::new();
        assert!(!pool.set_mode("missing", WindowMode::Session).await);
    }
}
