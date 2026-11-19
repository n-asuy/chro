use base64::{engine::general_purpose::STANDARD, Engine};
use mobile_link::*;
use serde_json::{json, Value};
fn hello() -> Value {
    json!({"type":"e2ee_hello","v":2,"clientPublicKeyB64":STANDARD.encode(HostKey::from_secret([7;32]).public_key()),"clientNonceB64":STANDARD.encode([2;32]),"capabilities":{"framing":[2],"payloadKinds":["text","binary"]},"context":{"protocol":PROTOCOL,"initiator":"mobile","responder":"desktop","transport":"direct"}})
}
#[test]
fn hello_rejections() {
    let good = hello();
    assert!(Hello::parse(&good.to_string(), &Context::direct()).is_ok());
    for key in good.as_object().unwrap().keys() {
        let mut v = good.clone();
        v.as_object_mut().unwrap().remove(key);
        assert!(
            Hello::parse(&v.to_string(), &Context::direct()).is_err(),
            "missing {key}"
        );
    }
    let mut cases = vec![json!(null), json!([]), json!({})];
    let mut add = |path: &[&str], value: Value| {
        let mut v = good.clone();
        let mut p = &mut v;
        for k in &path[..path.len() - 1] {
            p = &mut p[*k];
        }
        p[path[path.len() - 1]] = value;
        cases.push(v);
    };
    for (p, v) in [
        (vec!["extra"], json!(0)),
        (vec!["type"], json!("e2ee_ready")),
        (vec!["v"], json!(1)),
        (vec!["v"], json!(2.0)),
        (vec!["clientPublicKeyB64"], json!("AAAA")),
        (
            vec!["clientNonceB64"],
            json!(STANDARD.encode([2; 32]).trim_end_matches('=')),
        ),
        (vec!["clientPublicKeyB64"], json!(STANDARD.encode([0; 32]))),
        (vec!["capabilities", "extra"], json!(true)),
        (vec!["capabilities", "framing"], json!([2, 2])),
        (
            vec!["capabilities", "payloadKinds"],
            json!(["binary", "text"]),
        ),
        (vec!["context", "extra"], json!(0)),
        (vec!["context", "protocol"], json!("other")),
        (vec!["context", "initiator"], json!("desktop")),
        (vec!["context", "responder"], json!("mobile")),
        (vec!["context", "transport"], json!("relay")),
        (vec!["context", "relayHostId"], json!("AbCdEf0123_-xyZ9")),
    ] {
        add(&p, v)
    }
    for v in cases {
        assert!(
            Hello::parse(&v.to_string(), &Context::direct()).is_err(),
            "accepted {v}"
        );
    }
    assert!(Hello::parse("{", &Context::direct()).is_err());
    let duplicate = good.to_string().replacen('{', "{\"v\":2,", 1);
    assert!(Hello::parse(&duplicate, &Context::direct()).is_err());
    let mut relay = good.clone();
    relay["context"]["transport"] = json!("relay");
    relay["context"]["relayHostId"] = json!("AbCdEf0123_-xyZ9");
    let ctx = Context::new("relay", Some("AbCdEf0123_-xyZ9".into())).unwrap();
    assert!(Hello::parse(&relay.to_string(), &ctx).is_ok());
    assert!(Hello::parse(&relay.to_string(), &Context::direct()).is_err());
    assert!(Hello::parse(&good.to_string(), &ctx).is_err());
    assert!(Context::new("relay", Some("bad".into())).is_err());
}
#[test]
fn ready_rejections() {
    let h = Hello::parse(&hello().to_string(), &Context::direct()).unwrap();
    let host = HostKey::from_secret([8; 32]);
    let ready = h.ready(host.public_key(), [4; 32]);
    assert!(validate_ready(&ready.to_string(), &h, &host.public_key()).is_ok());
    for k in ready.as_object().unwrap().keys() {
        let mut v = ready.clone();
        v.as_object_mut().unwrap().remove(k);
        assert!(validate_ready(&v.to_string(), &h, &host.public_key()).is_err());
    }
    for (p, value) in [
        (vec!["extra"], json!(1)),
        (vec!["v"], json!(1)),
        (vec!["type"], json!("e2ee_hello")),
        (vec!["clientNonceB64"], json!(STANDARD.encode([3; 32]))),
        (vec!["desktopNonceB64"], json!("bad")),
        (vec!["selection", "framing"], json!(1)),
        (vec!["selection", "payloadKinds"], json!(["binary", "text"])),
        (vec!["selection", "extra"], json!(0)),
        (vec!["context", "protocol"], json!("other")),
    ] {
        let mut v = ready.clone();
        let mut a = &mut v;
        for k in &p[..p.len() - 1] {
            a = &mut a[*k];
        }
        a[p[p.len() - 1]] = value;
        assert!(validate_ready(&v.to_string(), &h, &host.public_key()).is_err());
    }
    assert!(validate_ready(&ready.to_string(), &h, &[0; 32]).is_err());
}
#[test]
fn auth_rejections() {
    let good = json!({"type":"e2ee_auth","v":2,"transcriptHashB64":STANDARD.encode([3;32]),"deviceToken":"a".repeat(48)});
    assert!(validate_auth(&good.to_string(), &[3; 32]).is_ok());
    for k in good.as_object().unwrap().keys() {
        let mut v = good.clone();
        v.as_object_mut().unwrap().remove(k);
        assert!(validate_auth(&v.to_string(), &[3; 32]).is_err());
    }
    for (k, x) in [
        ("type", json!("wrong")),
        ("v", json!(1)),
        ("extra", json!(true)),
        ("deviceToken", json!("")),
        ("deviceToken", json!(7)),
        ("transcriptHashB64", json!(STANDARD.encode([4; 32]))),
        ("transcriptHashB64", json!("bad")),
    ] {
        let mut v = good.clone();
        v[k] = x;
        assert!(validate_auth(&v.to_string(), &[3; 32]).is_err());
    }
}
#[test]
fn responder_lifecycle() {
    let p = std::env::temp_dir().join(format!("chro-handshake-{}.json", rand::random::<u64>()));
    let host = HostKey::from_secret([8; 32]);
    let mut registry = Registry::open(&p).unwrap();
    let offer = Offers::default()
        .issue(
            &mut registry,
            &host,
            "ws://localhost:6768",
            "Phone",
            1,
            false,
        )
        .unwrap();
    let mut server = Responder::new(host, Context::direct(), 100);
    assert!(server.tick(10099).is_empty());
    let a = server.receive(WireMessage::Text(hello().to_string()), 101, &mut registry);
    let Action::Send(WireMessage::Text(ready)) = &a[0] else {
        panic!("{a:?}")
    };
    let r: Value = serde_json::from_str(ready).unwrap();
    let dp: [u8; 32] = STANDARD
        .decode(r["desktopPublicKeyB64"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let dn: [u8; 32] = STANDARD
        .decode(r["desktopNonceB64"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let client = HostKey::from_secret([7; 32]);
    let keys = SessionKeys::derive(
        client.shared(dp).unwrap(),
        &[2; 32],
        &dn,
        &transcript(&Context::direct(), &client.public_key(), &[2; 32], &dp, &dn),
    );
    let auth = json!({"type":"e2ee_auth","v":2,"transcriptHashB64":STANDARD.encode(keys.transcript_hash),"deviceToken":offer.offer.device_token});
    let f = keys
        .seal_at(0, Kind::Text, 0, auth.to_string().as_bytes())
        .unwrap();
    let actions = server.receive(WireMessage::Text(STANDARD.encode(f)), 102, &mut registry);
    assert!(matches!(&actions[0], Action::Send(_)));
    assert!(server.credential().is_some());
    assert!(server.tick(999999).is_empty());
    let c = server.credential().unwrap().clone();
    let f = keys.seal_at(0, Kind::Binary, 1, b"payload").unwrap();
    assert!(matches!(
        &server.receive(WireMessage::Binary(f), 103, &mut registry)[0],
        Action::Payload {
            kind: Kind::Binary,
            ..
        }
    ));
    for i in 0..5 {
        let a = server.receive(WireMessage::Text("bad".into()), 104 + i, &mut registry);
        if i < 4 {
            assert!(a.is_empty())
        } else {
            assert!(matches!(&a[0], Action::Close(Close { code: 4003, .. })))
        }
    }
    registry.revoke(&c.device_id).unwrap();
    std::fs::remove_file(p).unwrap();
}
#[test]
fn timeout_and_binary_handshake() {
    let p = std::env::temp_dir().join(format!("chro-missing-{}", rand::random::<u64>()));
    let mut r = Registry::open(&p).unwrap();
    let mut s = Responder::new(HostKey::generate(), Context::direct(), 10);
    assert_eq!(
        s.tick(10010),
        vec![Action::Close(Close::handshake_timeout())]
    );
    assert!(s
        .receive(WireMessage::Text(hello().to_string()), 10011, &mut r)
        .is_empty());
    let mut s = Responder::new(HostKey::generate(), Context::direct(), 0);
    assert!(matches!(
        &s.receive(WireMessage::Binary(vec![]), 1, &mut r)[0],
        Action::Close(Close { code: 4001, .. })
    ));
}

fn connected(registry: &mut Registry, host: HostKey) -> (Responder, SessionKeys) {
    let mut server = Responder::new(host, Context::direct(), 100);
    let a = server.receive(WireMessage::Text(hello().to_string()), 101, registry);
    let Action::Send(WireMessage::Text(ready)) = &a[0] else {
        panic!("{a:?}")
    };
    let r: Value = serde_json::from_str(ready).unwrap();
    let dp = STANDARD
        .decode(r["desktopPublicKeyB64"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let dn = STANDARD
        .decode(r["desktopNonceB64"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let client = HostKey::from_secret([7; 32]);
    let keys = SessionKeys::derive(
        client.shared(dp).unwrap(),
        &[2; 32],
        &dn,
        &transcript(&Context::direct(), &client.public_key(), &[2; 32], &dp, &dn),
    );
    (server, keys)
}
fn auth(keys: &SessionKeys, token: &str, hash: [u8; 32]) -> WireMessage {
    let p = json!({"type":"e2ee_auth","v":2,"transcriptHashB64":STANDARD.encode(hash),"deviceToken":token});
    WireMessage::Text(
        STANDARD.encode(
            keys.seal_at(0, Kind::Text, 0, p.to_string().as_bytes())
                .unwrap(),
        ),
    )
}
fn assert_auth_error(actions: Vec<Action>, keys: &SessionKeys, error: AuthError, counter: u64) {
    assert_eq!(actions.len(), 2);
    let Action::Send(WireMessage::Text(s)) = &actions[0] else {
        panic!("{actions:?}")
    };
    let p = keys
        .open_at(1, Kind::Text, counter, &STANDARD.decode(s).unwrap())
        .unwrap();
    let v: Value = serde_json::from_slice(&p).unwrap();
    assert_eq!(v["error"]["code"], error.code());
    assert_eq!(actions[1], Action::Close(error.close()));
}
#[test]
fn responder_auth_errors_and_closed_state() {
    let p = std::env::temp_dir().join(format!("chro-auth-{}.json", rand::random::<u64>()));
    let mut r = Registry::open(&p).unwrap();
    let host = HostKey::generate();
    let offer = Offers::default()
        .issue(&mut r, &host, "ws://localhost:6768", "Phone", 1, false)
        .unwrap();
    let (mut s, k) = connected(&mut r, host.clone());
    assert_auth_error(
        s.receive(auth(&k, "wrong", k.transcript_hash), 102, &mut r),
        &k,
        AuthError::Unauthorized,
        0,
    );
    assert!(s
        .receive(WireMessage::Text(hello().to_string()), 103, &mut r)
        .is_empty());
    assert!(s.send(Kind::Text, b"x").is_err());
    let (mut s, k) = connected(&mut r, host.clone());
    assert_auth_error(
        s.receive(auth(&k, &offer.offer.device_token, [0; 32]), 102, &mut r),
        &k,
        AuthError::BadProof,
        0,
    );
    for msg in [
        WireMessage::Binary(vec![0; 82]),
        WireMessage::Text("invalid".into()),
    ] {
        let (mut s, k) = connected(&mut r, host.clone());
        assert_auth_error(s.receive(msg, 102, &mut r), &k, AuthError::BadAuth, 0);
    }
    let (mut s, k) = connected(&mut r, host.clone());
    std::fs::write(&p, "invalid").unwrap();
    assert_auth_error(
        s.receive(
            auth(&k, &offer.offer.device_token, k.transcript_hash),
            102,
            &mut r,
        ),
        &k,
        AuthError::RegistryUnavailable,
        0,
    );
    std::fs::remove_file(p).unwrap();
}
#[test]
fn revoke_is_checked_before_decryption_and_failures_reset() {
    let p = std::env::temp_dir().join(format!("chro-revoke-{}.json", rand::random::<u64>()));
    let mut r = Registry::open(&p).unwrap();
    let host = HostKey::generate();
    let offer = Offers::default()
        .issue(&mut r, &host, "ws://localhost:6768", "Phone", 1, false)
        .unwrap();
    let (mut s, k) = connected(&mut r, host);
    s.receive(
        auth(&k, &offer.offer.device_token, k.transcript_hash),
        102,
        &mut r,
    );
    for _ in 0..4 {
        assert!(s
            .receive(WireMessage::Text("bad".into()), 103, &mut r)
            .is_empty());
    }
    let valid = k.seal_at(0, Kind::Text, 1, b"{}").unwrap();
    assert!(matches!(
        s.receive(WireMessage::Text(STANDARD.encode(valid)), 104, &mut r)[0],
        Action::Payload { .. }
    ));
    for _ in 0..4 {
        assert!(s
            .receive(WireMessage::Text("bad".into()), 105, &mut r)
            .is_empty());
    }
    let c = s.credential().unwrap().clone();
    assert!(r.matches_token(&c, &offer.offer.device_token));
    assert!(!r.matches_token(&c, "wrong"));
    r.revoke(&c.device_id).unwrap();
    let a = s.receive(WireMessage::Text("bad".into()), 106, &mut r);
    assert_auth_error(a, &k, AuthError::DeviceRevoked, 1);
    std::fs::remove_file(p).unwrap();
}
#[test]
fn missing_nested_fields_and_noncanonical_base64() {
    let h = Hello::parse(&hello().to_string(), &Context::direct()).unwrap();
    let host = HostKey::generate();
    let ready = h.ready(host.public_key(), [4; 32]);
    for (base, object, keys) in [
        (
            hello(),
            "context",
            vec!["protocol", "initiator", "responder", "transport"],
        ),
        (hello(), "capabilities", vec!["framing", "payloadKinds"]),
        (ready.clone(), "selection", vec!["framing", "payloadKinds"]),
        (
            ready.clone(),
            "context",
            vec!["protocol", "initiator", "responder", "transport"],
        ),
    ] {
        for key in keys {
            let mut v = base.clone();
            v[object].as_object_mut().unwrap().remove(key);
            if base["type"] == "e2ee_hello" {
                assert!(Hello::parse(&v.to_string(), &Context::direct()).is_err());
            } else {
                assert!(validate_ready(&v.to_string(), &h, &host.public_key()).is_err());
            }
        }
    }
    for bad in [
        "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ=",
        "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
        "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=\n",
        "__________________________________________8=",
    ] {
        let mut v = hello();
        v["clientNonceB64"] = json!(bad);
        assert!(Hello::parse(&v.to_string(), &Context::direct()).is_err());
        let mut v = ready.clone();
        v["desktopNonceB64"] = json!(bad);
        assert!(validate_ready(&v.to_string(), &h, &host.public_key()).is_err());
    }
}

/// The step functions a listener with its own socket loop uses: the same
/// handshake as `Responder`, with raw sealed bytes instead of wire messages.
#[test]
fn listener_steps_answer_hello_and_accept_auth() {
    let p = std::env::temp_dir().join(format!("chro-steps-{}.json", rand::random::<u64>()));
    let host = HostKey::from_secret([8; 32]);
    let mut registry = Registry::open(&p).unwrap();
    let offer = Offers::default()
        .issue(
            &mut registry,
            &host,
            "ws://localhost:6768",
            "Phone",
            1,
            false,
        )
        .unwrap();

    assert!(answer_hello(&host, &Context::direct(), "{}").is_err());
    let open = |registry: &mut Registry, token: &str, proof: Option<[u8; 32]>| {
        let (ready, mut framer) =
            answer_hello(&host, &Context::direct(), &hello().to_string()).unwrap();
        let h = Hello::parse(&hello().to_string(), &Context::direct()).unwrap();
        let dn = validate_ready(&ready, &h, &host.public_key()).unwrap();
        let client = HostKey::from_secret([7; 32]);
        let dp = host.public_key();
        let keys = SessionKeys::derive(
            client.shared(dp).unwrap(),
            &[2; 32],
            &dn,
            &transcript(&Context::direct(), &client.public_key(), &[2; 32], &dp, &dn),
        );
        let p = json!({"type":"e2ee_auth","v":2,"transcriptHashB64":STANDARD.encode(proof.unwrap_or(keys.transcript_hash)),"deviceToken":token});
        let frame = keys
            .seal_at(0, Kind::Text, 0, p.to_string().as_bytes())
            .unwrap();
        let accepted = accept_auth(&mut framer, &frame, 10, registry);
        (accepted, keys, framer)
    };

    let (accepted, keys, mut framer) = open(&mut registry, &offer.offer.device_token, None);
    let accepted = accepted.unwrap();
    assert_eq!(accepted.credential.device_id, offer.offer.paired_device_id);
    assert_eq!(accepted.device_token, offer.offer.device_token);
    let sealed = accepted.sealed_reply;
    let reply: Value =
        serde_json::from_slice(&keys.open_at(1, Kind::Text, 0, &sealed).unwrap()).unwrap();
    assert_eq!(reply["type"], "e2ee_authenticated");
    assert_eq!(
        reply["transcriptHashB64"],
        STANDARD.encode(keys.transcript_hash)
    );
    // The framer continues the session at counter 1 in both directions.
    let next = keys.seal_at(0, Kind::Binary, 1, b"payload").unwrap();
    assert_eq!(framer.open(Kind::Binary, &next).unwrap(), b"payload");
    let out = framer.seal(Kind::Text, b"reply").unwrap();
    assert_eq!(keys.open_at(1, Kind::Text, 1, &out).unwrap(), b"reply");

    for (token, proof, error) in [
        ("f".repeat(48), None, AuthError::Unauthorized),
        (
            offer.offer.device_token.clone(),
            Some([0; 32]),
            AuthError::BadProof,
        ),
    ] {
        let (accepted, keys, _) = open(&mut registry, &token, proof);
        let refusal = accepted.unwrap_err();
        assert_eq!(refusal.error, error);
        let v: Value = serde_json::from_slice(
            &keys
                .open_at(1, Kind::Text, 0, &refusal.sealed_reply)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(v["error"]["code"], error.code());
    }

    let (_, mut framer) = answer_hello(&host, &Context::direct(), &hello().to_string()).unwrap();
    let refusal = accept_auth(&mut framer, b"not a frame", 10, &mut registry).unwrap_err();
    assert_eq!(refusal.error, AuthError::BadAuth);
    std::fs::remove_file(p).unwrap();
}
