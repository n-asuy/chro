//! Addresses the phone listener advertises and accepts.
//!
//! Advertised: this machine's IPv4 interface addresses (the listener binds
//! IPv4), without loopback (on the phone it names the phone), proxy fake-IP
//! ranges and link-local addresses, ordered so the best pairing address comes
//! first: tailnet, then LAN, then virtual bridges.
//!
//! Accepted: connections from loopback, private ranges, the tailnet
//! ranges, or a public address on the same subnet as one of this machine's
//! interfaces. Everything else is closed before the WebSocket handshake.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::Serialize;

use super::link::SourceClass;

/// What an advertised address is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AddressKind {
    Lan,
    Tailnet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct AdvertisedAddress {
    pub address: String,
    pub kind: AddressKind,
    /// The interface name.
    pub label: String,
}

/// One IPv4 interface address with its netmask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InterfaceAddress {
    pub name: String,
    pub ip: Ipv4Addr,
    pub netmask: Ipv4Addr,
}

/// The machine's IPv4 interface addresses.
pub(crate) fn interface_addresses() -> Vec<InterfaceAddress> {
    match if_addrs::get_if_addrs() {
        Ok(interfaces) => interfaces
            .into_iter()
            .filter_map(|interface| match interface.addr {
                if_addrs::IfAddr::V4(v4) => Some(InterfaceAddress {
                    name: interface.name,
                    ip: v4.ip,
                    netmask: v4.netmask,
                }),
                if_addrs::IfAddr::V6(_) => None,
            })
            .collect(),
        Err(err) => {
            tracing::warn!(error = %err, "could not list network interfaces");
            Vec::new()
        }
    }
}

fn in_v4(ip: Ipv4Addr, network: [u8; 4], prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    u32::from(ip) & mask == u32::from(Ipv4Addr::from(network)) & mask
}

fn in_v6(ip: Ipv6Addr, network: Ipv6Addr, prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    };
    u128::from(ip) & mask == u128::from(network) & mask
}

fn is_tailnet_v4(ip: Ipv4Addr) -> bool {
    in_v4(ip, [100, 64, 0, 0], 10)
}

/// Proxy tools hand out fake IPs from the benchmarking range.
fn is_proxy_fake_ip(ip: Ipv4Addr) -> bool {
    in_v4(ip, [198, 18, 0, 0], 15)
}

const BRIDGE_PREFIXES: &[&str] = &[
    "docker", "br-", "virbr", "vmnet", "vboxnet", "veth", "lxcbr", "cni", "flannel", "cali",
    "bridge",
];
const BRIDGE_NAMES: &[&str] = &[
    "VMware Network Adapter",
    "VirtualBox Host-Only",
    "vEthernet (WSL",
    "vEthernet (Default Switch",
];

fn is_virtual_bridge(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    BRIDGE_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
        || BRIDGE_NAMES.iter().any(|known| name.starts_with(known))
}

/// Addresses to offer for pairing, best first.
pub(crate) fn advertised_addresses(interfaces: &[InterfaceAddress]) -> Vec<AdvertisedAddress> {
    let mut ranked: Vec<(u8, AdvertisedAddress)> = interfaces
        .iter()
        .filter(|interface| {
            !interface.ip.is_loopback()
                && !is_proxy_fake_ip(interface.ip)
                && !interface.ip.is_link_local()
        })
        .map(|interface| {
            let (rank, kind) = if is_tailnet_v4(interface.ip) {
                (0, AddressKind::Tailnet)
            } else if is_virtual_bridge(&interface.name) {
                (2, AddressKind::Lan)
            } else {
                (1, AddressKind::Lan)
            };
            (
                rank,
                AdvertisedAddress {
                    address: interface.ip.to_string(),
                    kind,
                    label: interface.name.clone(),
                },
            )
        })
        .collect();
    ranked.sort_by_key(|(rank, _)| *rank);
    let mut seen = std::collections::HashSet::new();
    ranked
        .into_iter()
        .map(|(_, address)| address)
        .filter(|address| seen.insert(address.address.clone()))
        .collect()
}

/// Classify a connection's source, or `None` when it must be refused.
pub(crate) fn classify_source(ip: IpAddr, interfaces: &[InterfaceAddress]) -> Option<SourceClass> {
    let ip = match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    };
    match ip {
        IpAddr::V4(v4) => {
            if v4.is_loopback() {
                Some(SourceClass::Loopback)
            } else if is_tailnet_v4(v4) {
                Some(SourceClass::Tailnet)
            } else if v4.is_private() || v4.is_link_local() {
                Some(SourceClass::Private)
            } else if interfaces.iter().any(|interface| {
                !interface.ip.is_loopback()
                    && u32::from(interface.netmask) != 0
                    && u32::from(interface.ip) & u32::from(interface.netmask)
                        == u32::from(v4) & u32::from(interface.netmask)
            }) {
                Some(SourceClass::SameLink)
            } else {
                None
            }
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() {
                Some(SourceClass::Loopback)
            } else if in_v6(v6, Ipv6Addr::new(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0), 48) {
                Some(SourceClass::Tailnet)
            } else if in_v6(v6, Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7)
                || in_v6(v6, Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10)
            {
                Some(SourceClass::Private)
            } else {
                None
            }
        }
    }
}

/// The key unauthenticated sockets are counted under: the IPv4 host, or the
/// IPv6 /64.
pub(crate) fn source_key(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let segments = v6.segments();
                format!(
                    "{:x}:{:x}:{:x}:{:x}::/64",
                    segments[0], segments[1], segments[2], segments[3]
                )
            }
        },
    }
}

/// Why an address cannot be offered for pairing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EndpointError(pub String);

/// The `ws://` or `wss://` endpoint phones dial for `address`.
///
/// `address` is a hostname, IPv4 or IPv6 literal, optionally with a port
/// (the listener's port otherwise), or a `ws`/`wss`/`http`/`https` URL
/// (`http` becomes `ws`, `https` becomes `wss`). URLs with credentials, a
/// path, a query or fragment, port 0, a wildcard host, and anything that is
/// not an IP literal or an RFC 1123 hostname are refused.
pub(crate) fn pairing_endpoint(address: &str, port: u16) -> Result<String, EndpointError> {
    let address = address.trim();
    if address.is_empty() {
        return Err(EndpointError("the address is empty".into()));
    }
    if address.contains(char::is_whitespace) {
        return Err(EndpointError("contains a space".into()));
    }
    let (scheme, rest) = match address.split_once("://") {
        Some((scheme, rest)) => {
            let scheme = match scheme.to_ascii_lowercase().as_str() {
                "ws" | "http" => "ws",
                "wss" | "https" => "wss",
                other => return Err(EndpointError(format!("unsupported scheme {other}"))),
            };
            (scheme, rest)
        }
        None => ("ws", address),
    };
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.contains(['/', '?', '#']) {
        return Err(EndpointError(
            "the address must not have a path, query or fragment".into(),
        ));
    }
    if authority.contains('@') {
        return Err(EndpointError(
            "the address must not carry credentials".into(),
        ));
    }
    let (host, explicit_port) = split_host_port(authority)?;
    if host.is_empty() {
        return Err(EndpointError("the address has no host".into()));
    }
    let bracketed = host.starts_with('[');
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<IpAddr>() {
        Ok(ip) if ip.is_unspecified() => {
            return Err(EndpointError("a wildcard address cannot be dialed".into()));
        }
        Ok(IpAddr::V4(_)) if bracketed => {
            return Err(EndpointError("only IPv6 addresses go in brackets".into()));
        }
        Ok(_) => {}
        Err(_) if bracketed => {
            return Err(EndpointError("not an IPv6 address".into()));
        }
        Err(_) if !is_hostname(bare) => {
            return Err(EndpointError("not an IP address or hostname".into()));
        }
        Err(_) => {}
    }
    let port = match explicit_port {
        Some(0) => return Err(EndpointError("port 0 cannot be dialed".into())),
        Some(port) => port,
        None if scheme == "wss" && address.contains("://") => 443,
        None => port,
    };
    let host = match bare.parse::<Ipv6Addr>() {
        Ok(v6) => format!("[{v6}]"),
        Err(_) => host.to_string(),
    };
    Ok(format!("{scheme}://{host}:{port}"))
}

/// An RFC 1123 hostname: dot-separated labels of letters, digits and inner
/// hyphens, 1 to 63 characters each, 253 in all. The last label must not be
/// numeric: URL parsers read such a name as an IPv4 address (`256.0.0.1`,
/// `example.123`, `example.0x1f`), so it is a mistyped IP, not a host.
fn is_hostname(name: &str) -> bool {
    let label_ok = |label: &str| {
        (1..=63).contains(&label.len())
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    let last = name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let numeric_last = last.bytes().all(|b| b.is_ascii_digit())
        || last
            .strip_prefix("0x")
            .is_some_and(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit()));
    name.len() <= 253 && name.split('.').all(label_ok) && !numeric_last
}

fn split_host_port(authority: &str) -> Result<(&str, Option<u16>), EndpointError> {
    // Canonical ports only: no sign, no leading zero.
    let parse_port = |text: &str| match text.parse::<u16>() {
        Ok(port) if !text.starts_with(['0', '+']) || text == "0" => Ok(port),
        _ => Err(EndpointError(format!("{text:?} is not a port"))),
    };
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest
            .split_once(']')
            .ok_or_else(|| EndpointError("unclosed IPv6 bracket".into()))?;
        let port = match after.strip_prefix(':') {
            Some(port) => Some(parse_port(port)?),
            None if after.is_empty() => None,
            None => return Err(EndpointError("garbage after the IPv6 address".into())),
        };
        return Ok((&authority[..host.len() + 2], port));
    }
    if authority.matches(':').count() > 1 {
        // A bare IPv6 address without a port.
        return Ok((authority, None));
    }
    match authority.split_once(':') {
        Some((host, port)) => Ok((host, Some(parse_port(port)?))),
        None => Ok((authority, None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iface(name: &str, ip: [u8; 4], mask: [u8; 4]) -> InterfaceAddress {
        InterfaceAddress {
            name: name.into(),
            ip: Ipv4Addr::from(ip),
            netmask: Ipv4Addr::from(mask),
        }
    }

    #[test]
    fn sources_are_classified_by_range() {
        let none = [];
        let cases: &[(&str, Option<SourceClass>)] = &[
            ("127.0.0.1", Some(SourceClass::Loopback)),
            ("::1", Some(SourceClass::Loopback)),
            ("::ffff:127.0.0.1", Some(SourceClass::Loopback)),
            ("192.168.1.20", Some(SourceClass::Private)),
            ("10.1.2.3", Some(SourceClass::Private)),
            ("172.16.0.9", Some(SourceClass::Private)),
            ("169.254.3.4", Some(SourceClass::Private)),
            ("100.64.0.1", Some(SourceClass::Tailnet)),
            ("100.127.255.254", Some(SourceClass::Tailnet)),
            ("fd7a:115c:a1e0::1", Some(SourceClass::Tailnet)),
            ("fd00::1", Some(SourceClass::Private)),
            ("fe80::1", Some(SourceClass::Private)),
            ("100.128.0.1", None),
            ("8.8.8.8", None),
            ("2001:db8::1", None),
        ];
        for (ip, expected) in cases {
            assert_eq!(
                classify_source(ip.parse().unwrap(), &none),
                *expected,
                "{ip}"
            );
        }
    }

    #[test]
    fn a_public_address_on_a_local_subnet_is_same_link() {
        let interfaces = [
            iface("lo0", [127, 0, 0, 1], [255, 0, 0, 0]),
            iface("en0", [203, 0, 113, 10], [255, 255, 255, 0]),
        ];
        assert_eq!(
            classify_source("203.0.113.77".parse().unwrap(), &interfaces),
            Some(SourceClass::SameLink)
        );
        assert_eq!(
            classify_source("203.0.114.77".parse().unwrap(), &interfaces),
            None
        );
    }

    #[test]
    fn unauthenticated_sources_count_by_host_or_v6_prefix() {
        assert_eq!(source_key("192.168.1.2".parse().unwrap()), "192.168.1.2");
        assert_eq!(
            source_key("::ffff:192.168.1.2".parse().unwrap()),
            "192.168.1.2"
        );
        assert_eq!(
            source_key("2001:db8:1:2:aa::1".parse().unwrap()),
            source_key("2001:db8:1:2:bb::9".parse().unwrap())
        );
        assert_ne!(
            source_key("2001:db8:1:2::1".parse().unwrap()),
            source_key("2001:db8:1:3::1".parse().unwrap())
        );
    }

    #[test]
    fn advertised_addresses_rank_tailnet_then_lan_then_bridges_without_loopback() {
        let interfaces = [
            iface("lo0", [127, 0, 0, 1], [255, 0, 0, 0]),
            iface("docker0", [172, 17, 0, 1], [255, 255, 0, 0]),
            iface("en0", [192, 168, 1, 23], [255, 255, 255, 0]),
            iface("utun4", [100, 101, 102, 103], [255, 255, 255, 255]),
            iface("en5", [169, 254, 10, 1], [255, 255, 0, 0]),
            iface("utun9", [198, 18, 0, 1], [255, 255, 0, 0]),
        ];
        let advertised = advertised_addresses(&interfaces);
        let order: Vec<(&str, AddressKind)> = advertised
            .iter()
            .map(|a| (a.address.as_str(), a.kind))
            .collect();
        assert_eq!(
            order,
            vec![
                ("100.101.102.103", AddressKind::Tailnet),
                ("192.168.1.23", AddressKind::Lan),
                ("172.17.0.1", AddressKind::Lan),
            ]
        );
        assert_eq!(advertised[0].label, "utun4");
    }

    #[test]
    fn loopback_is_never_advertised() {
        let interfaces = [
            iface("lo0", [127, 0, 0, 1], [255, 0, 0, 0]),
            iface("lo0", [127, 0, 0, 2], [255, 0, 0, 0]),
        ];
        assert_eq!(advertised_addresses(&interfaces), vec![]);
    }

    #[test]
    fn pairing_endpoints_are_normalized() {
        let ok: &[(&str, &str)] = &[
            ("192.168.1.23", "ws://192.168.1.23:6768"),
            ("192.168.1.23:7000", "ws://192.168.1.23:7000"),
            ("mac.tailnet.ts.net", "ws://mac.tailnet.ts.net:6768"),
            ("http://mac.local:6770/", "ws://mac.local:6770"),
            ("https://relay.example.com", "wss://relay.example.com:443"),
            (
                "wss://relay.example.com:8443",
                "wss://relay.example.com:8443",
            ),
            ("fd7a:115c:a1e0::5", "ws://[fd7a:115c:a1e0::5]:6768"),
            ("[fd7a:115c:a1e0::5]:7000", "ws://[fd7a:115c:a1e0::5]:7000"),
            ("mac.tail1234.ts.net:7443", "ws://mac.tail1234.ts.net:7443"),
            ("localhost", "ws://localhost:6768"),
            ("  home-mac.local  ", "ws://home-mac.local:6768"),
            ("HTTPS://Relay.Example.com/", "wss://Relay.Example.com:443"),
            ("ws://100.101.102.103:7000", "ws://100.101.102.103:7000"),
        ];
        for (input, expected) in ok {
            assert_eq!(pairing_endpoint(input, 6768).unwrap(), *expected, "{input}");
        }
        // A 64-character label, and a 263-character name.
        let long_label = format!("{}.com", "a".repeat(64));
        let long_host = format!("{}com", "abcdefghi.".repeat(26));
        for bad in [
            "",
            "ftp://host",
            "ws://user:pw@host",
            "ws://host/path",
            "ws://host?x",
            "ws://host#f",
            "host:0",
            "0.0.0.0",
            "[::]",
            "host:notaport",
            "host:65536",
            "host:0080",
            "two words",
            "ws://two words",
            "under_score.example.com",
            "-leading.example.com",
            "trailing-.example.com",
            "double..dot",
            "256.0.0.1",
            "192.168.1",
            "example.123",
            "example.0x1f",
            "[example.com]",
            "[192.168.1.2]",
            "ws://",
            "ws://:7000",
            "chro://pair",
            long_label.as_str(),
            long_host.as_str(),
        ] {
            assert!(pairing_endpoint(bad, 6768).is_err(), "{bad}");
        }
    }
}
