use base64::{engine::general_purpose::STANDARD, Engine};
use mobile_link::*;
use serde_json::Value;
fn bytes(v: &Value, k: &str) -> Vec<u8> {
    let s = v[k].as_str().unwrap();
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn arr(v: &Value, k: &str) -> [u8; 32] {
    bytes(v, k).try_into().unwrap()
}
fn context(v: &Value) -> Context {
    Context::new(
        v["context"]["transport"].as_str().unwrap(),
        v["context"]["relayHostId"].as_str().map(str::to_owned),
    )
    .unwrap()
}
fn check(v: &Value, shared: [u8; 32]) -> SessionKeys {
    let tr = transcript(
        &context(v),
        &arr(v, "clientPublicKeyHex"),
        &arr(v, "clientNonceHex"),
        &arr(v, "desktopPublicKeyHex"),
        &arr(v, "desktopNonceHex"),
    );
    if v.get("transcriptHex").is_some() {
        assert_eq!(tr, bytes(v, "transcriptHex"));
        assert_eq!(tr.len() as u64, v["transcriptLength"].as_u64().unwrap());
    }
    let k = SessionKeys::derive(
        shared,
        &arr(v, "clientNonceHex"),
        &arr(v, "desktopNonceHex"),
        &tr,
    );
    assert_eq!(k.transcript_hash, arr(v, "transcriptHashHex"));
    assert_eq!(k.mobile_to_desktop, arr(v, "mobileToDesktopKeyHex"));
    assert_eq!(k.desktop_to_mobile, arr(v, "desktopToMobileKeyHex"));
    assert_eq!(k.session_id, arr(v, "sessionIdHex"));
    k
}
#[test]
fn every_vector() {
    let v: Value = serde_json::from_str(include_str!("../testdata/e2ee-v2-vectors.json")).unwrap();
    assert_eq!(v["labels"]["protocol"], PROTOCOL);
    assert_eq!(v["labels"]["transcriptDomain"], TRANSCRIPT_DOMAIN);
    assert_eq!(v["labels"]["salt"], SALT_LABEL);
    assert_eq!(v["labels"]["session"], SESSION_LABEL);
    for x in v["keySchedule"].as_array().unwrap() {
        check(x, arr(x, "sharedHex"));
    }
    let x = &v["endToEnd"];
    let client = HostKey::from_secret(arr(x, "clientSecretKeyHex"));
    let host = HostKey::from_secret(arr(x, "desktopSecretKeyHex"));
    assert_eq!(client.public_key(), arr(x, "clientPublicKeyHex"));
    assert_eq!(host.public_key(), arr(x, "desktopPublicKeyHex"));
    let shared = host.shared(client.public_key()).unwrap();
    assert_eq!(shared, arr(x, "sharedHex"));
    assert_eq!(client.shared(host.public_key()).unwrap(), shared);
    let k = check(x, shared);
    for f in x["frames"].as_array().unwrap() {
        let d = f["direction"].as_u64().unwrap() as u8;
        let kind = Kind::try_from(f["kind"].as_u64().unwrap() as u8).unwrap();
        let c = f["counter"].as_u64().unwrap();
        let p = if let Some(s) = f["payloadUtf8"].as_str() {
            s.as_bytes().to_vec()
        } else {
            bytes(f, "payloadHex")
        };
        let frame = k.seal_at(d, kind, c, &p).unwrap();
        assert_eq!(frame, bytes(f, "frameHex"));
        if let Some(s) = f["frameB64"].as_str() {
            assert_eq!(STANDARD.encode(&frame), s);
        }
        assert_eq!(k.open_at(d, kind, c, &frame).unwrap(), p);
        assert_eq!(
            frame.len() - p.len(),
            v["frameOverheadBytes"].as_u64().unwrap() as usize
        );
    }
    let n = &v["nonce"];
    assert_eq!(
        nonce(
            &arr(n, "sessionIdHex"),
            n["direction"].as_u64().unwrap() as u8,
            Kind::try_from(n["kind"].as_u64().unwrap() as u8).unwrap(),
            n["counter"].as_u64().unwrap()
        ),
        bytes(n, "nonceHex").as_slice()
    );
}
#[test]
fn framing_rejects() {
    let k = SessionKeys::derive([5; 32], &[2; 32], &[4; 32], b"transcript");
    let f = k.seal_at(0, Kind::Text, 0, b"hello").unwrap();
    let mut rx = Framer::responder(k.clone());
    assert_eq!(rx.open(Kind::Text, &f).unwrap(), b"hello");
    assert!(rx.open(Kind::Text, &f).is_err());
    for (d, kind, c) in [(0, Kind::Text, 2), (1, Kind::Text, 1), (0, Kind::Binary, 1)] {
        let f = k.seal_at(d, kind, c, b"x").unwrap();
        assert!(rx.open(Kind::Text, &f).is_err());
    }
    let foreign = SessionKeys::derive([6; 32], &[2; 32], &[4; 32], b"other")
        .seal_at(0, Kind::Text, 1, b"x")
        .unwrap();
    assert!(rx.open(Kind::Text, &foreign).is_err());
    let mut bad = k.seal_at(0, Kind::Text, 1, b"x").unwrap();
    bad[30] ^= 1;
    assert!(rx.open(Kind::Text, &bad).is_err());
    assert_eq!(
        rx.open(Kind::Binary, &k.seal_at(0, Kind::Binary, 1, b"ok").unwrap())
            .unwrap(),
        b"ok"
    );
}
