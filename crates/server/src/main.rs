use std::process::ExitCode;

use chro_server::args::Cli;
use clap::Parser;

#[tokio::main]
async fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(err) => return chro_server::cli::parse_failure(err),
    };

    match cli.command {
        None => match chro_server::run(cli.server).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("chro-server: {err:#}");
                ExitCode::FAILURE
            }
        },
        // Commands block on HTTP calls; keep them off the async workers.
        Some(command) => tokio::task::spawn_blocking(move || chro_server::cli::run(command, cli.global))
            .await
            .unwrap_or(ExitCode::FAILURE),
    }
}
