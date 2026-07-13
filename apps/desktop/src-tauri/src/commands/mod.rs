pub mod file_menu;
pub mod notification;
pub mod runtime_info;
pub mod shell;
pub mod update;
pub mod version;
pub mod workspace;

// `pub use *;` re-exports the `#[tauri::command]`-generated `__cmd__*` shim
// symbols alongside the user-facing functions so `tauri::generate_handler!`
// can resolve them through the `commands::*` paths used by `lib.rs`.
pub use file_menu::*;
pub use notification::*;
pub use runtime_info::*;
pub use shell::*;
pub use update::*;
pub use version::*;
pub use workspace::*;
