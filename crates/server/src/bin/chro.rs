//! The `chro` terminal CLI.
//!
//! The desktop bundle ships this next to the server sidecar and puts its
//! directory on the PATH of every agent it launches, so a running agent can
//! call `chro task ...` by bare name. It is a second binary rather than a copy
//! of the server because the two differ by the entire server runtime, which
//! would otherwise be downloaded and updated twice; the commands themselves are
//! the server crate's own, so there is one implementation.

use chro_server::args::TerminalCli;
use clap::Parser;

fn main() -> anyhow::Result<()> {
    let cli = TerminalCli::parse();

    chro_server::cli::run(&cli.command, cli.project.as_deref())
}
