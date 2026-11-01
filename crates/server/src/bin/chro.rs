//! The `chro` command line.
//!
//! The desktop bundle ships this next to the server sidecar and puts its
//! directory on the PATH of every agent it launches, so a running agent can
//! call `chro` by bare name. It is a second binary rather than a copy of the
//! server because the two differ by the entire server runtime, which would
//! otherwise be downloaded and updated twice; the commands themselves are the
//! server crate's own, so there is one implementation.

use std::process::ExitCode;

use chro_server::args::TerminalCli;
use clap::Parser;

fn main() -> ExitCode {
    let cli = match TerminalCli::try_parse() {
        Ok(cli) => cli,
        Err(err) => return chro_server::cli::parse_failure(err),
    };
    match cli.command {
        Some(command) => chro_server::cli::run(command, cli.global),
        None => chro_server::cli::print_help::<TerminalCli>(),
    }
}
