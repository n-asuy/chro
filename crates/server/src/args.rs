use std::path::PathBuf;

use clap::{Parser, Subcommand};

/// `chro-server`: the server the app runs as a sidecar, which also answers
/// every `chro` command so the npm package can ship a single binary.
#[derive(Parser, Debug)]
#[command(name = "chro-server", version, about = "Chro server and command line")]
pub struct Cli {
    #[command(flatten)]
    pub server: ServerArgs,

    #[command(flatten)]
    pub global: GlobalArgs,

    /// Without a command, run the server.
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(clap::Args, Debug)]
pub struct ServerArgs {
    #[arg(long = "db-path")]
    pub db_path: Option<PathBuf>,
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,
    #[arg(long, default_value = "4300")]
    pub port: u16,
    /// Enable per-request latency logging to log/performance/
    #[arg(long)]
    pub perf: bool,
    /// Do not open a browser on startup
    #[arg(long)]
    pub no_open: bool,
}

/// `chro`: drive a running chro app or server from a terminal or from an
/// agent running inside a chro session.
///
/// The desktop app ships this next to itself and puts its directory on the
/// PATH of every agent it starts, so an agent can call `chro` by bare name.
#[derive(Parser, Debug)]
#[command(
    name = "chro",
    version,
    about = "Drive chro sessions from a terminal or from inside a session",
    after_help = "Inside a chro session, `self` names the session and `parent` the one that delegated it.\nOutput is JSON when stdout is not a terminal; `chro schema` lists every command and error code."
)]
pub struct TerminalCli {
    #[command(flatten)]
    pub global: GlobalArgs,

    #[command(subcommand)]
    pub command: Option<Commands>,
}

/// Flags every command accepts.
#[derive(clap::Args, Debug, Clone, Default)]
pub struct GlobalArgs {
    /// Print the JSON envelope even on a terminal
    #[arg(long, global = true, conflicts_with = "human")]
    pub json: bool,
    /// Print for people even when stdout is not a terminal
    #[arg(long, global = true)]
    pub human: bool,
    /// Reuse the request id of an earlier attempt whose answer was lost, so a
    /// retried command does not act twice
    #[arg(long, global = true, value_name = "ID")]
    pub request_id: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Show which chro server this command talks to and who it acts as
    Status,
    /// Start the desktop app and wait until it accepts commands
    Open,
    /// Print every command, flag, selector, error code and exit code as JSON
    Schema,
    /// Repositories and folders sessions run in
    Project {
        #[command(subcommand)]
        command: crate::cli::ProjectCommand,
    },
    /// Create, inspect, message, delegate and land sessions
    Session {
        #[command(subcommand)]
        command: crate::cli::SessionCommand,
    },
    /// Answer tool calls and questions that sessions are waiting on
    Approval {
        #[command(subcommand)]
        command: crate::cli::ApprovalCommand,
    },
    /// Install the chro skill that teaches agents this command line
    Skill {
        #[command(subcommand)]
        command: crate::cli::SkillCommand,
    },
    /// Run chro on a machine managed by a control plane
    #[cfg(feature = "cloud")]
    Cloud {
        #[command(subcommand)]
        command: CloudCommand,
    },
}

/// Instance lifecycle, for a chro server run by a control plane instead of this
/// machine.
#[cfg(feature = "cloud")]
#[derive(Subcommand, Debug)]
pub enum CloudCommand {
    /// Record which control plane to use and how to authenticate to it
    Login {
        /// Base URL of the control plane
        url: String,
        /// Token issued by that control plane. Falls back to CHRO_CLOUD_TOKEN,
        /// so it need not appear in shell history.
        #[arg(long)]
        token: Option<String>,
    },
    /// Make the instance usable, creating it the first time
    Up,
    /// Stop the instance, keeping its disk
    Down,
    /// Show the instance and where it can be reached
    Status,
    /// Destroy the instance and everything on it
    Destroy,
}
