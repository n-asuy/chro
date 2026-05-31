use tauri::{AppHandle, Runtime as TauriRuntime};

#[tauri::command]
pub fn get_version<R: TauriRuntime>(app: AppHandle<R>) -> String {
    app.package_info().version.to_string()
}
