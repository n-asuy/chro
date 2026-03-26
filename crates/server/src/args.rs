use std::path::PathBuf;

use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "chro-server", about = "Local Chro backend (HTTP + WS)")]
pub struct Args {
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
