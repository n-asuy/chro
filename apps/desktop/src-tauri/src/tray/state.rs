use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrayStatus {
    Connected,
    Waiting,
    Error,
}

impl Default for TrayStatus {
    fn default() -> Self {
        TrayStatus::Connected
    }
}

#[derive(Debug, Clone, Default)]
pub struct TrayState {
    pub task_count: u32,
    pub status: TrayStatus,
}
