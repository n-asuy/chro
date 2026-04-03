use chro_server::{run, ServerArgs};
use clap::Parser;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    run(ServerArgs::parse()).await
}
