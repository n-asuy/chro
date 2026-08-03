mod approvals;
mod client;
mod task;

pub use approvals::ApprovalCommand;
pub use task::TaskCommand;

use std::path::Path;

use crate::args::Commands;

/// Run one terminal command against a server that is already up.
///
/// Both entry points reach the CLI through here: `chro-server <command>` and
/// the standalone `chro` binary the desktop app puts on the PATH of the agents
/// it launches. Keeping the dispatch in one place is what lets the two share a
/// single implementation of every command.
pub fn run(command: &Commands, project: Option<&Path>) -> anyhow::Result<()> {
    let client = client::ServerClient::connect().map_err(|e| anyhow::anyhow!("{e}"))?;

    match command {
        Commands::Task { command } => {
            task::run(command, &client, project).map_err(|e| anyhow::anyhow!("{e}"))
        }
        Commands::Approvals { command } => {
            approvals::run(command, &client).map_err(|e| anyhow::anyhow!("{e}"))
        }
    }
}
