use std::{env, path::PathBuf};

use tokio::fs;

pub async fn write_port_file(port: u16) -> std::io::Result<PathBuf> {
    let dir = env::temp_dir().join("chro");
    let path = dir.join("chro.port");
    tracing::debug!("Writing port {} to {:?}", port, path);
    fs::create_dir_all(&dir).await?;
    fs::write(&path, port.to_string()).await?;
    Ok(path)
}
