use std::net::{IpAddr, SocketAddr, TcpListener};
use std::path::PathBuf;

use anyhow::{Context, Result};

/// Match the historical behavior of the Electron build: probe a TCP listener on
/// the requested address and report whether it could bind.
pub fn is_port_available(host: &str, port: u16) -> bool {
    let Ok(ip) = host.parse::<IpAddr>() else {
        return false;
    };
    TcpListener::bind(SocketAddr::new(ip, port)).is_ok()
}

/// Walk forward from `start_port` until we find a free port. The Electron build
/// did the same thing starting at 4310; we keep the convention so the dev-loop
/// is predictable when running `chro-server` standalone alongside the desktop.
pub fn find_available_port(host: &str, start_port: u16) -> Result<u16> {
    let mut attempt = start_port;
    loop {
        if is_port_available(host, attempt) {
            return Ok(attempt);
        }
        attempt = attempt
            .checked_add(1)
            .context("exhausted u16 port space looking for a free port")?;
    }
}

/// `/tmp/chro/chro.port` — written by chro-server in CLI mode and also read by
/// the Vite dev server proxy. The desktop runtime writes it as well so the
/// vite dev server can discover the live backend port without polling the
/// runtime.
pub fn port_file_path() -> PathBuf {
    std::env::temp_dir().join("chro").join("chro.port")
}

pub fn write_port_file(port: u16) -> Result<()> {
    let path = port_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating port dir {}", parent.display()))?;
    }
    std::fs::write(&path, port.to_string())
        .with_context(|| format!("writing port file {}", path.display()))?;
    Ok(())
}
