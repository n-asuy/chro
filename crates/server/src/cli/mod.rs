//! The `chro` command line: a thin client of the operator API.
//!
//! Every command either reads local facts (the shipped skill, the command
//! schema) or makes typed operator API calls through [`client::Client`]; none
//! touches the server's internal `/rpc` surface. Output and exit codes follow
//! one contract, described by `chro schema`.

mod approval;
mod client;
#[cfg(feature = "cloud")]
mod cloud;
mod discovery;
mod open;
mod output;
mod project;
mod render;
mod schema;
mod session;
mod skill;

pub use approval::ApprovalCommand;
pub use project::ProjectCommand;
pub use session::SessionCommand;
pub use skill::SkillCommand;

use std::process::ExitCode;

use server_contract::{routes, Meta};

use crate::args::{Commands, GlobalArgs};
use client::{Answer, Client};
use output::{finish, Failure, Mode};

/// Run one command. Both entry points come through here: `chro`, which the
/// app ships beside itself and puts on every agent's PATH, and `chro-server
/// <command>`, which the npm package runs.
pub fn run(command: Commands, global: GlobalArgs) -> ExitCode {
    let mode = Mode::detect(global.json, global.human);
    let connect = || Client::connect(global.request_id.clone());
    match command {
        Commands::Status => finish(
            mode,
            connect()
                .map_err(Failure::from)
                .and_then(|client| client.call(&routes::STATUS, &[], &[], None)),
        ),
        Commands::Open => finish(
            mode,
            open::open()
                .and_then(|_| connect())
                .map_err(Failure::from)
                .and_then(|client| client.call(&routes::STATUS, &[], &[], None)),
        ),
        Commands::Schema => finish(
            mode,
            Ok::<_, Failure>(Answer {
                result: schema::schema(),
                meta: Meta::local(),
            }),
        ),
        Commands::Project { command } => project::run(command, connect(), mode),
        Commands::Session { command } => session::run(command, connect(), mode),
        Commands::Approval { command } => approval::run(command, connect(), mode),
        Commands::Skill { command } => skill::run(command, mode),
        #[cfg(feature = "cloud")]
        Commands::Cloud { command } => match cloud::run(&command) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => output::fail(
                mode,
                server_contract::ErrorBody::new(
                    server_contract::ErrorCode::Internal,
                    err.to_string(),
                ),
            ),
        },
    }
}

/// `chro` with no command: print help, exit as a usage error so scripts that
/// forget the command do not mistake it for success.
pub fn print_help<C: clap::CommandFactory>() -> ExitCode {
    let _ = C::command().print_help();
    println!();
    ExitCode::from(server_contract::ErrorCode::Usage.exit_code())
}

/// Parse failures exit with the usage code; `--help` and `--version` succeed.
pub fn parse_failure(err: clap::Error) -> ExitCode {
    let code = if err.use_stderr() {
        server_contract::ErrorCode::Usage.exit_code()
    } else {
        0
    };
    let _ = err.print();
    ExitCode::from(code)
}
