//! `/rpc/mobile/*`: the desktop's Mobile settings pane.
//!
//! | route | body | answer |
//! |---|---|---|
//! | `GET /rpc/mobile/interfaces` | | `{addresses: [{address, kind, label}]}`, best pairing address first, never loopback |
//! | `GET /rpc/mobile/address-preference` | | `{customAddresses, selectedCustomAddress}` |
//! | `PUT /rpc/mobile/address-preference` | `{customAddresses, selectedCustomAddress}` | the saved preference |
//! | `POST /rpc/mobile/pairing-offer` | `{address?, rotate?}` | `{pairingUrl, qrSvg, endpoint, expiresAt}` |
//! | `GET /rpc/mobile/devices` | | `{devices: [{id, name, pairedAt, lastSeenAt?}]}` |
//! | `DELETE /rpc/mobile/devices/:id` | | `{}` once removed on disk and disconnected |
//!
//! Times are epoch milliseconds.
//!
//! The address preference lives in the desktop config, so it survives
//! restarts. Every custom address must pass [`network::pairing_endpoint`]
//! before it is saved. An offer without an `address` uses the selected custom
//! address, else the best detected one; with neither it is refused.
//!
//! Failures answer `{error: {code, message}}` with an HTTP status:
//! `mobile_unavailable` (503), `invalid_address` (400), `invalid_device_id`
//! (400), `device_not_found` (404), `registry_error` (500),
//! `listener_error` (500), `config_error` (500).

use std::{net::IpAddr, sync::Arc};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::{
    link::LinkError,
    network::{self, AdvertisedAddress},
    MobileHub,
};
use crate::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/mobile/interfaces", get(interfaces))
        .route(
            "/mobile/address-preference",
            get(address_preference).put(save_address_preference),
        )
        .route("/mobile/pairing-offer", post(pairing_offer))
        .route("/mobile/devices", get(devices))
        .route("/mobile/devices/:id", delete(revoke))
}

#[derive(Debug)]
pub(crate) struct MobileApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl MobileApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn registry(err: LinkError) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "registry_error", err.0)
    }

    fn invalid_address(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_address", message)
    }
}

impl IntoResponse for MobileApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

type MobileResult<T> = Result<Json<T>, MobileApiError>;

fn hub(state: &AppState) -> Result<Arc<MobileHub>, MobileApiError> {
    state.mobile().ok_or_else(|| {
        MobileApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "mobile_unavailable",
            "phone pairing is not running on this server",
        )
    })
}

/// Run a registry call off the async workers: it may read and fsync files.
async fn blocking<T: Send + 'static>(
    call: impl FnOnce() -> T + Send + 'static,
) -> Result<T, MobileApiError> {
    tokio::task::spawn_blocking(call).await.map_err(|err| {
        MobileApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "registry_error",
            err.to_string(),
        )
    })
}

#[derive(Debug, Serialize)]
pub(crate) struct InterfacesResponse {
    pub addresses: Vec<AdvertisedAddress>,
}

async fn interfaces(State(state): State<AppState>) -> MobileResult<InterfacesResponse> {
    let hub = hub(&state)?;
    Ok(Json(InterfacesResponse {
        addresses: network::advertised_addresses(&hub.interfaces()),
    }))
}

/// More than anyone types by hand; keeps the config bounded.
pub(crate) const MAX_CUSTOM_ADDRESSES: usize = 32;

/// Any port works for validation: it only fills in a missing one.
const VALIDATION_PORT: u16 = 6768;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AddressPreference {
    pub custom_addresses: Vec<String>,
    pub selected_custom_address: Option<String>,
}

impl From<config::MobilePairingConfig> for AddressPreference {
    fn from(saved: config::MobilePairingConfig) -> Self {
        Self {
            custom_addresses: saved.custom_addresses,
            selected_custom_address: saved.selected_custom_address,
        }
    }
}

impl AddressPreference {
    /// Trimmed, without duplicates, each address dialable, and the selection
    /// one of them.
    fn validated(self) -> Result<config::MobilePairingConfig, MobileApiError> {
        let mut custom_addresses: Vec<String> = Vec::new();
        for address in &self.custom_addresses {
            let address = address.trim();
            network::pairing_endpoint(address, VALIDATION_PORT).map_err(|err| {
                MobileApiError::invalid_address(format!("{address:?}: {}", err.0))
            })?;
            if !custom_addresses.iter().any(|saved| saved == address) {
                custom_addresses.push(address.to_string());
            }
        }
        if custom_addresses.len() > MAX_CUSTOM_ADDRESSES {
            return Err(MobileApiError::invalid_address(format!(
                "at most {MAX_CUSTOM_ADDRESSES} custom addresses can be saved"
            )));
        }
        let selected_custom_address = match self.selected_custom_address {
            None => None,
            Some(selected) => {
                let selected = selected.trim();
                if !custom_addresses.iter().any(|saved| saved == selected) {
                    return Err(MobileApiError::invalid_address(format!(
                        "{selected:?} is not one of the custom addresses"
                    )));
                }
                Some(selected.to_string())
            }
        };
        Ok(config::MobilePairingConfig {
            custom_addresses,
            selected_custom_address,
        })
    }
}

async fn address_preference(State(state): State<AppState>) -> MobileResult<AddressPreference> {
    let config = state.runtime().current_config().await;
    Ok(Json(config.mobile_pairing.into()))
}

async fn save_address_preference(
    State(state): State<AppState>,
    Json(request): Json<AddressPreference>,
) -> MobileResult<AddressPreference> {
    let preference = request.validated()?;
    let updated = state
        .runtime()
        .update_config(|config| config.mobile_pairing = preference)
        .await
        .map_err(|err| {
            MobileApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "config_error",
                err.to_string(),
            )
        })?;
    Ok(Json(updated.mobile_pairing.into()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PairingOfferRequest {
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub rotate: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingOfferResponse {
    pub pairing_url: String,
    pub qr_svg: String,
    pub endpoint: String,
    pub expires_at: u64,
}

async fn pairing_offer(
    State(state): State<AppState>,
    Json(request): Json<PairingOfferRequest>,
) -> MobileResult<PairingOfferResponse> {
    let hub = hub(&state)?;
    let port = hub.port().ok_or_else(|| {
        MobileApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "mobile_unavailable",
            "the phone listener is not running",
        )
    })?;
    let address = match request.address {
        Some(address) => address,
        None => {
            let saved = state.runtime().current_config().await.mobile_pairing;
            default_address(
                saved.selected_custom_address,
                &network::advertised_addresses(&hub.interfaces()),
            )
            .ok_or_else(|| MobileApiError::invalid_address(NO_REACHABLE_ADDRESS))?
        }
    };
    let endpoint = network::pairing_endpoint(&address, port).map_err(|err| {
        MobileApiError::invalid_address(format!("{:?}: {}", address.trim(), err.0))
    })?;
    if !is_loopback_endpoint(&endpoint) {
        hub.expose().await.map_err(|err| {
            MobileApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "listener_error",
                format!("could not accept network connections on port {port}: {err}"),
            )
        })?;
    }
    let link = hub.link();
    let offer_endpoint = endpoint.clone();
    let offer = blocking(move || link.issue_offer(&offer_endpoint, request.rotate))
        .await?
        .map_err(MobileApiError::registry)?;
    Ok(Json(PairingOfferResponse {
        pairing_url: offer.pairing_url,
        qr_svg: offer.qr_svg,
        endpoint,
        expires_at: offer.expires_at,
    }))
}

const NO_REACHABLE_ADDRESS: &str = "No reachable network address is available for pairing. Connect to Wi\u{2011}Fi or Tailscale, or pick an address manually.";

/// The selected custom address, else the best detected one.
fn default_address(
    selected_custom: Option<String>,
    detected: &[AdvertisedAddress],
) -> Option<String> {
    selected_custom.or_else(|| detected.first().map(|address| address.address.clone()))
}

fn is_loopback_endpoint(endpoint: &str) -> bool {
    let authority = endpoint
        .split_once("://")
        .map_or(endpoint, |(_, rest)| rest);
    let host = match authority.rsplit_once(':') {
        Some((host, _port)) => host,
        None => authority,
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceView {
    pub id: Uuid,
    pub name: String,
    pub paired_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<u64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct DevicesResponse {
    pub devices: Vec<DeviceView>,
}

async fn devices(State(state): State<AppState>) -> MobileResult<DevicesResponse> {
    let hub = hub(&state)?;
    let link = hub.link();
    let devices = blocking(move || link.devices())
        .await?
        .map_err(MobileApiError::registry)?;
    Ok(Json(DevicesResponse {
        devices: devices
            .into_iter()
            .map(|device| DeviceView {
                id: device.id,
                name: device.name,
                paired_at: device.paired_at,
                last_seen_at: device.last_seen_at,
            })
            .collect(),
    }))
}

#[derive(Debug, Serialize)]
pub(crate) struct Revoked {}

async fn revoke(State(state): State<AppState>, Path(id): Path<String>) -> MobileResult<Revoked> {
    let hub = hub(&state)?;
    let device_id = Uuid::parse_str(&id).map_err(|_| {
        MobileApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_device_id",
            format!("{id:?} is not a device id"),
        )
    })?;
    let link = hub.link();
    let removed = blocking(move || link.revoke(device_id))
        .await?
        .map_err(MobileApiError::registry)?;
    if !removed {
        return Err(MobileApiError::new(
            StatusCode::NOT_FOUND,
            "device_not_found",
            format!("no paired device {device_id}"),
        ));
    }
    let cut = hub.disconnect(device_id);
    tracing::info!(device = %device_id, connections = cut, "revoked a paired device");
    Ok(Json(Revoked {}))
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn loopback_endpoints_are_recognized() {
        assert!(is_loopback_endpoint("ws://127.0.0.1:6768"));
        assert!(is_loopback_endpoint("ws://localhost:6768"));
        assert!(is_loopback_endpoint("ws://[::1]:6768"));
        assert!(!is_loopback_endpoint("ws://192.168.1.2:6768"));
        assert!(!is_loopback_endpoint("wss://relay.example.com:443"));
    }

    #[test]
    fn the_default_address_prefers_the_selected_custom_one() {
        let detected = [AdvertisedAddress {
            address: "100.64.0.9".into(),
            kind: network::AddressKind::Tailnet,
            label: "utun4".into(),
        }];
        assert_eq!(
            default_address(Some("mac.tail1234.ts.net".into()), &detected).as_deref(),
            Some("mac.tail1234.ts.net")
        );
        assert_eq!(
            default_address(None, &detected).as_deref(),
            Some("100.64.0.9")
        );
        assert_eq!(default_address(None, &[]), None);
    }
}
