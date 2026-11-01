use std::net::{IpAddr, SocketAddr, TcpListener};

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
