use chro_server::args::Cli;
use clap::Parser;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        None => chro_server::run(cli.server).await,
        Some(command) => chro_server::cli::run(&command, cli.project.as_deref()),
    }
}
