mod approvals;
mod client;
mod task;

pub use approvals::ApprovalCommand;
pub use task::TaskCommand;

use std::path::Path;

pub fn run_task(command: &TaskCommand, project: Option<&Path>) -> anyhow::Result<()> {
    let client = client::ServerClient::connect().map_err(|e| anyhow::anyhow!("{e}"))?;

    task::run(command, &client, project).map_err(|e| anyhow::anyhow!("{e}"))
}

pub fn run_approvals(command: &ApprovalCommand) -> anyhow::Result<()> {
    let client = client::ServerClient::connect().map_err(|e| anyhow::anyhow!("{e}"))?;

    approvals::run(command, &client).map_err(|e| anyhow::anyhow!("{e}"))
}
