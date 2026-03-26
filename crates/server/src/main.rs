use clap::Parser;
use chro_server::{run, ServerArgs};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    run(ServerArgs::parse()).await
}
