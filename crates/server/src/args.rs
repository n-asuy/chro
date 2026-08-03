use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "chro", version, about = "Chro — AI-powered productivity tool")]
pub struct Cli {
    #[command(flatten)]
    pub server: ServerArgs,

    /// Git repository path (for task commands; default: CWD's git root)
    #[arg(short = 'w', long)]
    pub project: Option<PathBuf>,

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

/// Command line of the standalone `chro` binary: the same commands as
/// `chro-server`, without the server the app runs as a sidecar. Agents launched
/// by chro get this binary on their PATH, so `chro task ...` resolves by bare
/// name from inside a run.
#[derive(Parser, Debug)]
#[command(name = "chro", version, about = "Chro — task and approval commands")]
pub struct TerminalCli {
    /// Git repository path (default: CWD's git root)
    #[arg(short = 'w', long)]
    pub project: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Task management
    Task {
        #[command(subcommand)]
        command: crate::cli::TaskCommand,
    },
    /// Approval workflow: list, inspect, and respond to pending approvals
    Approvals {
        #[command(subcommand)]
        command: crate::cli::ApprovalCommand,
    },
}
