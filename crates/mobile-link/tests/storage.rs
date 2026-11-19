use mobile_link::*;
use std::{fs, path::PathBuf};
fn dir() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "chro-mobile-test-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ));
    fs::create_dir_all(&p).unwrap();
    p
}
#[test]
fn identity_persistence_and_errors() {
    let d = dir();
    let p = d.join("key.json");
    let k = HostKey::load_or_generate(&p).unwrap();
    assert_eq!(
        k.public_key(),
        HostKey::load_or_generate(&p).unwrap().public_key()
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(&p).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::write(&p, b"broken").unwrap();
    assert!(HostKey::load_or_generate(&p).is_err());
    assert_eq!(fs::read(&p).unwrap(), b"broken");
    assert!(HostKey::load_or_generate(&d).is_err());
    fs::remove_dir_all(d).unwrap();
}
#[test]
fn offers_exchange_registry_revoke() {
    let d = dir();
    let p = d.join("devices.json");
    let mut r = Registry::open(&p).unwrap();
    let h = HostKey::from_secret([9; 32]);
    let mut o = Offers::default();
    let offer = o
        .issue(&mut r, &h, "ws://192.168.1.2:6768", "Phone", 1000, false)
        .unwrap();
    assert_eq!(offer.expires_at, 601000);
    assert!(offer.pairing_url.starts_with("chro://pair?code="));
    assert!(!offer.pairing_url.contains('=') || offer.pairing_url.matches('=').count() == 1);
    assert!(offer.qr_svg.contains("<svg"));
    assert_eq!(
        o.issue(&mut r, &h, "ws://192.168.1.2:6768", "Phone", 2000, false)
            .unwrap()
            .pairing_url,
        offer.pairing_url
    );
    let ticket = offer.offer.device_token.clone();
    let c = r.authenticate(&ticket, 3000).unwrap();
    let new = "a".repeat(48);
    r.exchange_ticket(&c, &new, 4000).unwrap();
    r.exchange_ticket(&c, &new, 4001).unwrap();
    assert!(r.exchange_ticket(&c, &"b".repeat(48), 4002).is_err());
    let mut r = Registry::open(&p).unwrap();
    assert!(r.check(&c, 4500).is_ok());
    let nc = r.authenticate(&new, 5000).unwrap();
    assert_eq!(nc.revision, c.revision + 1);
    assert!(r.check(&c, 5003).is_err());
    assert!(r.authenticate(&ticket, 5001).is_err());
    assert!(r.exchange_ticket(&nc, &"c".repeat(48), 5002).is_err());
    assert!(r.check(&nc, 5003).is_ok());
    let disk = fs::read_to_string(&p).unwrap();
    assert!(!disk.contains(&new));
    assert!(!disk.contains(&ticket));
    assert!(r.revoke(&nc.device_id).unwrap());
    assert!(r.check(&nc, 5004).is_err());
    assert!(Registry::open(&p).unwrap().devices().is_empty());
    fs::remove_dir_all(d).unwrap();
}
#[test]
fn expiry_rotation_and_external_revoke() {
    let d = dir();
    let p = d.join("devices.json");
    let mut r = Registry::open(&p).unwrap();
    let h = HostKey::from_secret([9; 32]);
    let mut o = Offers::default();
    let a = o
        .issue(&mut r, &h, "ws://localhost:6768", "Phone", 0, false)
        .unwrap();
    assert!(r.authenticate(&a.offer.device_token, 600000).is_err());
    let b = o
        .issue(&mut r, &h, "ws://localhost:6768", "Phone", 600001, true)
        .unwrap();
    let c = r.authenticate(&b.offer.device_token, 600002).unwrap();
    fs::write(&p, "[]").unwrap();
    assert!(r.check(&c, 600003).is_err());
    fs::write(&p, "bad").unwrap();
    assert!(r.revoke(&c.device_id).is_err());
    assert_eq!(fs::read_to_string(&p).unwrap(), "bad");
    fs::remove_dir_all(d).unwrap();
}
#[test]
fn failed_persistence_does_not_commit() {
    let d = dir();
    let p = d.join("devices.json");
    let mut r = Registry::open(&p).unwrap();
    let h = HostKey::from_secret([9; 32]);
    let a = Offers::default()
        .issue(&mut r, &h, "ws://localhost:6768", "Phone", 1, false)
        .unwrap();
    let c = r.authenticate(&a.offer.device_token, 2).unwrap();
    let saved = fs::read(&p).unwrap();
    fs::remove_file(&p).unwrap();
    fs::create_dir(&p).unwrap();
    assert!(r.revoke(&c.device_id).is_err());
    assert_eq!(r.devices().len(), 1);
    fs::remove_dir(&p).unwrap();
    fs::write(&p, saved).unwrap();
    assert!(r.check(&c, 3).is_ok());
    fs::remove_dir_all(d).unwrap();
}

#[test]
fn unreadable_identity_is_not_replaced_and_symlinks_are_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let d = dir();
    let p = d.join("key.json");
    let host = HostKey::load_or_generate(&p).unwrap();
    let original = fs::read(&p).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o0)).unwrap();
    assert!(HostKey::load_or_generate(&p).is_err());
    fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(fs::read(&p).unwrap(), original);
    assert_eq!(HostKey::load(&p).unwrap().public_key(), host.public_key());
    let link = d.join("link.json");
    symlink(&p, &link).unwrap();
    assert!(HostKey::load_or_generate(&link).is_err());
    fs::remove_file(&p).unwrap();
    assert!(HostKey::load_or_generate(&link).is_err());
    assert!(!p.exists());
    fs::remove_dir_all(d).unwrap();
}
#[test]
fn ticket_exchange_window_collision_and_rotation() {
    let d = dir();
    let mut r = Registry::open(d.join("devices.json")).unwrap();
    let host = HostKey::generate();
    let mut o = Offers::default();
    let first = o
        .issue(&mut r, &host, "ws://localhost:6768", "One", 100, false)
        .unwrap();
    let c1 = r.authenticate(&first.offer.device_token, 200).unwrap();
    let second = o
        .issue(&mut r, &host, "ws://localhost:6768", "Two", 300, true)
        .unwrap();
    let c2 = r.authenticate(&second.offer.device_token, 400).unwrap();
    assert!(r.check(&c1, 500).is_ok());
    assert!(r
        .exchange_ticket(&c1, &second.offer.device_token, 500)
        .is_err());
    for invalid in ["", "A", &"G".repeat(48), &"a".repeat(47), &"a".repeat(129)] {
        assert!(r.exchange_ticket(&c1, invalid, 500).is_err());
    }
    assert!(r.exchange_ticket(&c1, &"c".repeat(48), 600200).is_err());
    assert!(r.check(&c2, 500).is_ok());
    fs::remove_dir_all(d).unwrap();
}
#[test]
fn qr_encoding_and_endpoint_rejections() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let d = dir();
    let mut r = Registry::open(d.join("devices.json")).unwrap();
    let host = HostKey::generate();
    let mut o = Offers::default();
    for endpoint in [
        "",
        "https://example.com",
        "ws://",
        "ws://user@host",
        "ws://host/path",
        "ws://host#x",
        "ws://host:0",
        "ws://host:99999",
        "ws://0.0.0.0:6768",
        "ws://[::]:6768",
        "ws://[bad]:6768",
        "ws://::1:6768",
        "ws://host:foo",
        "ws://host:6768?token=x",
    ] {
        assert!(
            o.issue(&mut r, &host, endpoint, "Phone", 1, false).is_err(),
            "{endpoint}"
        );
    }
    let x = o
        .issue(&mut r, &host, "ws://[::1]:6768", "Phone", 10, false)
        .unwrap();
    let decoded = URL_SAFE_NO_PAD
        .decode(x.pairing_url.strip_prefix("chro://pair?code=").unwrap())
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&decoded).unwrap(),
        serde_json::to_value(&x.offer).unwrap()
    );
    let code =
        qrcode::QrCode::with_error_correction_level(x.pairing_url.as_bytes(), qrcode::EcLevel::M)
            .unwrap();
    let size = (code.width() + 8) * 2;
    assert!(x.qr_svg.contains(&format!("viewBox=\"0 0 {size} {size}\"")));
    fs::remove_dir_all(d).unwrap();
}
#[test]
fn listener_side_credentials_sources_and_ticket_state() {
    let d = dir();
    let p = d.join("devices.json");
    let mut r = Registry::open(&p).unwrap();
    let h = HostKey::from_secret([9; 32]);
    let offer = Offers::default()
        .issue(&mut r, &h, "ws://192.168.1.2:6768", "Phone", 1000, false)
        .unwrap();
    let ticket = offer.offer.device_token.clone();
    let row = |r: &Registry| r.devices()[0].clone();
    assert!(row(&r).is_ticket());
    assert_eq!(row(&r).last_source, None);

    let c = r.authenticate(&ticket, 2000).unwrap();
    // A listener rebuilds the credential from what the connection kept.
    let rebuilt = Credential::for_token(&c.device_id, c.revision, &ticket);
    assert_eq!(rebuilt, c);
    assert!(r.check(&rebuilt, 2001).is_ok());
    assert!(r
        .check(&Credential::for_token(&c.device_id, c.revision, &"f".repeat(48)), 2001)
        .is_err());
    assert!(r
        .check(&Credential::for_token(&c.device_id, c.revision + 1, &ticket), 2001)
        .is_err());

    r.record_source(&c, "tailnet", 2100).unwrap();
    let written = fs::metadata(&p).unwrap().modified().unwrap();
    r.record_source(&c, "tailnet", 2100).unwrap();
    assert_eq!(
        fs::metadata(&p).unwrap().modified().unwrap(),
        written,
        "an unchanged source is not rewritten"
    );
    let reopened = Registry::open(&p).unwrap();
    assert_eq!(row(&reopened).last_source.as_deref(), Some("tailnet"));

    let new = "a".repeat(48);
    r.exchange_ticket(&c, &new, 3000).unwrap();
    assert!(row(&r).is_ticket(), "a ticket until the new token authenticates");
    let nc = r.authenticate(&new, 4000).unwrap();
    assert!(!row(&r).is_ticket());
    assert_eq!(row(&r).last_source.as_deref(), Some("tailnet"));
    assert!(matches!(
        r.record_source(&c, "private", 4001),
        Err(Error::Protocol("device_revoked"))
    ));
    r.record_source(&nc, "private", 4002).unwrap();
    assert_eq!(row(&Registry::open(&p).unwrap()).last_source.as_deref(), Some("private"));
    fs::remove_dir_all(d).unwrap();
}
#[test]
fn a_host_without_a_registry_file_refuses_tokens_as_unauthorized() {
    let d = dir();
    let p = d.join("devices.json");
    let mut r = Registry::open(&p).unwrap();
    assert!(matches!(
        r.authenticate(&"a".repeat(48), 1),
        Err(Error::Protocol("unauthorized"))
    ));
    assert!(!p.exists(), "refusing a token writes nothing");
    // A file that vanishes under known devices is not an empty registry.
    let h = HostKey::from_secret([9; 32]);
    let offer = Offers::default()
        .issue(&mut r, &h, "ws://127.0.0.1:6768", "Phone", 1, false)
        .unwrap();
    fs::remove_file(&p).unwrap();
    assert!(matches!(
        r.authenticate(&offer.offer.device_token, 2),
        Err(Error::Io(_))
    ));
    fs::remove_dir_all(d).unwrap();
}
/// A ticket that was used but never exchanged lives only as long as its
/// exchange window: after that it neither authenticates nor keeps a
/// connection standing, so a failed exchange cannot leave the photographed
/// QR code as a permanent credential.
#[test]
fn a_used_ticket_expires_with_its_exchange_window() {
    let d = dir();
    let mut r = Registry::open(d.join("devices.json")).unwrap();
    let h = HostKey::from_secret([9; 32]);
    let offer = Offers::default()
        .issue(&mut r, &h, "ws://localhost:6768", "Phone", 0, false)
        .unwrap();
    let ticket = offer.offer.device_token.clone();
    let first_use = 1000;
    let c = r.authenticate(&ticket, first_use).unwrap();
    let closes = first_use + TICKET_EXCHANGE_WINDOW_MS;

    // Inside the window the ticket reconnects and stays standing.
    assert!(r.check(&c, closes - 1).is_ok());
    let again = r.authenticate(&ticket, closes - 1).unwrap();
    assert_eq!(again, c, "reconnecting does not restart the window");

    // At the window's end it is refused on both paths.
    assert!(matches!(
        r.check(&c, closes),
        Err(Error::Protocol("device_revoked"))
    ));
    assert!(matches!(
        r.authenticate(&ticket, closes),
        Err(Error::Protocol("unauthorized"))
    ));
    assert!(matches!(
        r.exchange_ticket(&c, &"a".repeat(48), closes),
        Err(Error::Protocol("device_revoked"))
    ));
    fs::remove_dir_all(d).unwrap();
}

/// A lost exchange reply is repaired either by repeating the exchange with
/// the same proposed token on the ticket, or by authenticating with that
/// token, which commits it. The second works after the ticket expired.
#[test]
fn an_uncertain_exchange_is_repaired_with_the_same_proposed_token() {
    let d = dir();
    let mut r = Registry::open(d.join("devices.json")).unwrap();
    let h = HostKey::from_secret([9; 32]);
    let offer = Offers::default()
        .issue(&mut r, &h, "ws://localhost:6768", "Phone", 0, false)
        .unwrap();
    let ticket = offer.offer.device_token.clone();
    let c = r.authenticate(&ticket, 1000).unwrap();
    let proposed = "d".repeat(64);
    let id = r.exchange_ticket(&c, &proposed, 2000).unwrap();

    // The reply was lost: the phone reconnects with the ticket and repeats.
    let reconnected = r.authenticate(&ticket, 3000).unwrap();
    assert_eq!(r.exchange_ticket(&reconnected, &proposed, 3001).unwrap(), id);
    assert!(matches!(
        r.exchange_ticket(&reconnected, &"e".repeat(64), 3002),
        Err(Error::Protocol("ticket_exchange_pending"))
    ));

    // Long after the window the proposed token still authenticates and
    // commits; the ticket does not.
    let late = 1000 + TICKET_EXCHANGE_WINDOW_MS + 60_000;
    assert!(r.authenticate(&ticket, late).is_err());
    let committed = r.authenticate(&proposed, late).unwrap();
    assert_eq!(committed.device_id, id);
    assert_eq!(committed.revision, c.revision + 1);
    assert!(r.check(&committed, late + 1).is_ok());
    assert!(!r.devices()[0].is_ticket());
    fs::remove_dir_all(d).unwrap();
}
