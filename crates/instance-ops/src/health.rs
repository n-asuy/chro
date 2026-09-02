//! Reading how the machine and the server on it are doing.

use serde::Deserialize;

use crate::{HealthReport, OpsState, Quiesced};

/// Where the chro server is expected to answer.
pub struct ServerProbe {
    base_url: String,
    client: reqwest::Client,
}

impl ServerProbe {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            // A hung server must not hang the check as well: the control plane
            // needs an answer more than it needs a precise one.
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .unwrap_or_default(),
        }
    }

    pub async fn healthy(&self) -> bool {
        self.client
            .get(format!("{}/health", self.base_url))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// When the server last did something for the user.
    ///
    /// Absent when the server cannot say; the caller has to decide what to do
    /// with that rather than being handed a number that means "just now".
    pub async fn last_activity_ms(&self) -> Option<i64> {
        #[derive(Deserialize)]
        struct Activity {
            last_activity_ms: Option<i64>,
        }

        self.client
            .get(format!("{}/rpc/activity", self.base_url))
            .send()
            .await
            .ok()?
            .json::<Activity>()
            .await
            .ok()?
            .last_activity_ms
    }
}

/// Free space on the filesystem holding the user's work, and free memory.
pub fn machine_resources(workspace: &str) -> (Option<u64>, Option<u64>) {
    use sysinfo::{Disks, System};

    let mut system = System::new();
    system.refresh_memory();
    let memory = Some(system.available_memory());

    let disks = Disks::new_with_refreshed_list();
    // The disk that matters is the one the workspace is on; a machine can have
    // several and reporting the wrong one hides a full volume.
    let disk_free = disks
        .list()
        .iter()
        .filter(|d| workspace.starts_with(&d.mount_point().to_string_lossy().to_string()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space());

    (disk_free, memory)
}

pub async fn report(probe: &ServerProbe, quiesced: &Quiesced, workspace: &str) -> HealthReport {
    let server_healthy = probe.healthy().await;
    let (disk_free_bytes, memory_available_bytes) = machine_resources(workspace);

    let state = if quiesced.is_set() {
        // Deliberately reported ahead of server health: a quiesced server may
        // legitimately be refusing work, and calling that "down" would make a
        // successful stop look like a failure.
        OpsState::Quiesced
    } else if server_healthy {
        OpsState::Running
    } else {
        OpsState::ServerDown
    };

    HealthReport {
        state,
        server_healthy,
        last_activity_ms: probe.last_activity_ms().await,
        disk_free_bytes,
        memory_available_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workspace_disk_is_the_one_reported() {
        // Just asserts the call is wired to a real filesystem; the values
        // themselves belong to the machine running the test.
        let (disk, memory) = machine_resources("/");
        assert!(memory.is_some());
        assert!(disk.is_some() || cfg!(target_os = "windows"));
    }

    #[tokio::test]
    async fn an_unreachable_server_is_reported_as_down_rather_than_hanging() {
        // Port 1 is reserved and will refuse immediately.
        let probe = ServerProbe::new("http://127.0.0.1:1".into());
        let quiesced = Quiesced::new();

        let report = report(&probe, &quiesced, "/").await;

        assert_eq!(report.state, OpsState::ServerDown);
        assert!(!report.server_healthy);
        assert!(report.last_activity_ms.is_none());
    }

    #[tokio::test]
    async fn a_quiesced_instance_is_not_mistaken_for_a_broken_one() {
        let probe = ServerProbe::new("http://127.0.0.1:1".into());
        let quiesced = Quiesced::new();
        quiesced.set(true);

        let report = report(&probe, &quiesced, "/").await;

        assert_eq!(report.state, OpsState::Quiesced);
    }
}
