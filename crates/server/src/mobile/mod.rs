//! Paired phones.
//!
//! A phone talks to this server over its own WebSocket listener, inside an
//! end-to-end encrypted link it set up by scanning a QR code on the desktop.
//! It never holds the owner token: it authenticates as a paired device, and
//! every call it makes runs in-process as [`Caller::Device`] against the
//! device allowlist.
//!
//! - [`link`]: the seam to the pairing and encryption library.
//! - [`disk_link`]: that seam on the library, with its files on disk.
//! - [`listener`]: the socket, its limits, the handshake, frame I/O.
//! - [`dispatch`]: the RPC families and in-process dispatch.
//! - [`allowlist`]: which endpoints a phone may call.
//! - [`mcp_redaction`]: the MCP configuration without its credentials.
//! - [`routes`]: `/rpc/mobile/*` for the desktop's Mobile settings pane.
//!
//! [`Caller::Device`]: crate::operator::Caller

pub(crate) mod allowlist;
pub(crate) mod binary;
pub(crate) mod connections;
pub(crate) mod disk_link;
pub(crate) mod dispatch;
pub(crate) mod envelope;
pub(crate) mod link;
pub(crate) mod listener;
pub(crate) mod mcp_redaction;
pub(crate) mod network;
pub(crate) mod routes;

#[cfg(test)]
pub(crate) mod fake_link;
#[cfg(test)]
mod paired_phone_tests;
#[cfg(test)]
mod schema_lock;
#[cfg(test)]
mod tests;

use std::{
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

use tokio::net::TcpListener;
use uuid::Uuid;

use self::{
    connections::{Caps, ConnectionTable},
    disk_link::DiskLink,
    dispatch::{Dispatcher, Limits},
    link::{DeviceLink, SourceClass},
    listener::{ListenerHandle, PortChoice, Timing},
    network::InterfaceAddress,
};
use crate::AppState;

/// Where a server keeps its phone pairing state: beside its database, so a
/// server on another database has its own key, registry and port memory.
pub(crate) fn data_dir(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("mobile")
}

type InterfaceSource = Arc<dyn Fn() -> Vec<InterfaceAddress> + Send + Sync>;

/// Limits and environment of a hub. Tests shorten the timings and pin the
/// interfaces.
#[derive(Clone)]
pub(crate) struct HubConfig {
    pub caps: Caps,
    pub timing: Timing,
    pub limits: Limits,
    pub interfaces: InterfaceSource,
    /// The router devices reach instead of the API's, for tests that need
    /// handlers they control.
    #[cfg(test)]
    pub router: Option<axum::Router>,
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            caps: Caps::default(),
            timing: Timing::default(),
            limits: Limits::default(),
            interfaces: Arc::new(network::interface_addresses),
            #[cfg(test)]
            router: None,
        }
    }
}

/// Everything about paired phones that lives for the server's lifetime.
pub(crate) struct MobileHub {
    link: Arc<dyn DeviceLink>,
    dispatcher: Dispatcher,
    table: ConnectionTable,
    timing: Timing,
    interfaces: InterfaceSource,
    listener: OnceLock<ListenerHandle>,
}

impl MobileHub {
    pub(crate) fn new(state: AppState, link: Arc<dyn DeviceLink>, config: HubConfig) -> Arc<Self> {
        #[cfg(not(test))]
        let router = dispatch::device_router(state.clone());
        #[cfg(test)]
        let router = config
            .router
            .clone()
            .unwrap_or_else(|| dispatch::device_router(state.clone()));
        Arc::new(Self {
            dispatcher: Dispatcher::new(state, Arc::clone(&link), router, config.limits),
            link,
            table: ConnectionTable::new(config.caps),
            timing: config.timing,
            interfaces: config.interfaces,
            listener: OnceLock::new(),
        })
    }

    /// Pair phones with the server whose database is `db_path`: load its
    /// key and registry from [`data_dir`] and start the listener.
    pub(crate) async fn serve(
        state: AppState,
        db_path: &Path,
        port: PortChoice,
    ) -> anyhow::Result<Arc<Self>> {
        let dir = data_dir(db_path);
        let link = {
            let dir = dir.clone();
            tokio::task::spawn_blocking(move || DiskLink::open(&dir)).await??
        };
        Ok(Self::start(state, Arc::new(link), &dir, port).await?)
    }

    /// Start the phone listener for this server and make it reachable from
    /// `state`: bind the first free port of the plan on loopback, remember a
    /// fallback port, and open to the network when a phone paired from there
    /// before.
    pub(crate) async fn start(
        state: AppState,
        link: Arc<dyn DeviceLink>,
        data_dir: &Path,
        choice: PortChoice,
    ) -> std::io::Result<Arc<Self>> {
        let hub = Self::new(state.clone(), link, HubConfig::default());
        let socket = listener::bind_loopback(&choice.plan(data_dir)).await?;
        let port = hub.open(socket).await?;
        if choice == PortChoice::Planned && port != listener::DEFAULT_PORT {
            if let Err(err) = listener::save_fallback_port(data_dir, port) {
                tracing::warn!(port, error = %err, "could not remember the phone listener port");
            }
        }
        state.install_mobile(Arc::clone(&hub));
        tracing::info!(port, "phone listener ready");
        Ok(hub)
    }

    /// Serve phones on `socket` (bound to loopback), opening it to the
    /// network when a phone paired from there before. Returns the port.
    pub(crate) async fn open(self: &Arc<Self>, socket: TcpListener) -> std::io::Result<u16> {
        let handle = listener::spawn(Arc::clone(self), socket)?;
        let port = handle.port();
        self.listener
            .set(handle)
            .map_err(|_| std::io::Error::other("the phone listener is already running"))?;
        if self.has_network_devices() {
            self.expose().await?;
        }
        Ok(port)
    }

    pub(crate) fn port(&self) -> Option<u16> {
        self.listener.get().map(ListenerHandle::port)
    }

    #[cfg(test)]
    pub(crate) fn scope(&self) -> Option<listener::BindScope> {
        self.listener.get().map(ListenerHandle::scope)
    }

    /// Accept connections from the network, not just loopback.
    pub(crate) async fn expose(&self) -> std::io::Result<()> {
        match self.listener.get() {
            Some(handle) => handle.expose().await,
            None => Err(std::io::Error::other("the phone listener is not running")),
        }
    }

    /// Terminate every connection of a device.
    pub(crate) fn disconnect(&self, device_id: Uuid) -> usize {
        self.table.disconnect(device_id)
    }

    fn has_network_devices(&self) -> bool {
        match self.link.devices() {
            Ok(devices) => devices.iter().any(|device| {
                device
                    .last_source
                    .is_some_and(|source| source != SourceClass::Loopback)
            }),
            Err(err) => {
                tracing::warn!(error = %err, "could not read paired devices");
                false
            }
        }
    }

    pub(crate) fn link(&self) -> Arc<dyn DeviceLink> {
        Arc::clone(&self.link)
    }

    pub(crate) fn dispatcher(&self) -> &Dispatcher {
        &self.dispatcher
    }

    pub(crate) fn table(&self) -> &ConnectionTable {
        &self.table
    }

    pub(crate) fn timing(&self) -> Timing {
        self.timing
    }

    pub(crate) fn interfaces(&self) -> Vec<InterfaceAddress> {
        (self.interfaces)()
    }
}
