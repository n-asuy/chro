use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "chro", about = "Chro — AI-powered productivity tool")]
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
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Task management
    Task {
        #[command(subcommand)]
        command: crate::cli::TaskCommand,
    },
}
