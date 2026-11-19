use crate::*;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use xsalsa20poly1305::{aead::Aead, KeyInit, XSalsa20Poly1305};
pub const PROTOCOL: &str = "chro-mobile-e2ee";
pub const TRANSCRIPT_DOMAIN: &str = "chro-mobile-e2ee/v2/transcript";
pub const SALT_LABEL: &str = "chro-mobile-e2ee/v2/salt\0";
pub const SESSION_LABEL: &str = "chro-mobile-e2ee/v2/session\0";
pub const FRAME_OVERHEAD: usize = 82;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Text = 0,
    Binary = 1,
}
impl TryFrom<u8> for Kind {
    type Error = Error;
    fn try_from(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Self::Text),
            1 => Ok(Self::Binary),
            _ => Err(Error::Invalid("kind")),
        }
    }
}
#[derive(Clone)]
pub struct SessionKeys {
    pub mobile_to_desktop: [u8; 32],
    pub desktop_to_mobile: [u8; 32],
    pub session_id: [u8; 32],
    pub transcript_hash: [u8; 32],
}
impl SessionKeys {
    pub fn derive(shared: [u8; 32], cn: &[u8; 32], dn: &[u8; 32], transcript: &[u8]) -> Self {
        let th: [u8; 32] = Sha256::digest(transcript).into();
        let mut salt = Sha256::new();
        salt.update(SALT_LABEL);
        salt.update(cn);
        salt.update(dn);
        let salt = salt.finalize();
        let info = [SESSION_LABEL.as_bytes(), &th].concat();
        let mut out = [0; 96];
        Hkdf::<Sha256>::new(Some(&salt), &shared)
            .expand(&info, &mut out)
            .expect("fixed HKDF size");
        Self {
            mobile_to_desktop: out[..32].try_into().unwrap(),
            desktop_to_mobile: out[32..64].try_into().unwrap(),
            session_id: out[64..].try_into().unwrap(),
            transcript_hash: th,
        }
    }
    fn key(&self, d: u8) -> Result<&[u8; 32]> {
        match d {
            0 => Ok(&self.mobile_to_desktop),
            1 => Ok(&self.desktop_to_mobile),
            _ => Err(Error::Invalid("direction")),
        }
    }
    pub fn seal_at(&self, d: u8, k: Kind, c: u64, p: &[u8]) -> Result<Vec<u8>> {
        let n = nonce(&self.session_id, d, k, c);
        let plain = [header(&self.session_id, d, k, c), p.to_vec()].concat();
        let cipher = XSalsa20Poly1305::new(self.key(d)?.into())
            .encrypt((&n).into(), plain.as_slice())
            .map_err(|_| Error::Invalid("encryption"))?;
        Ok([n.to_vec(), cipher].concat())
    }
    pub fn open_at(&self, d: u8, k: Kind, c: u64, f: &[u8]) -> Result<Vec<u8>> {
        let n = nonce(&self.session_id, d, k, c);
        if f.len() < FRAME_OVERHEAD || !eq(&n, &f[..24]) {
            return Err(Error::Invalid("nonce"));
        }
        let p = XSalsa20Poly1305::new(self.key(d)?.into())
            .decrypt((&n).into(), &f[24..])
            .map_err(|_| Error::Invalid("ciphertext"))?;
        if !eq(&header(&self.session_id, d, k, c), &p[..42]) {
            return Err(Error::Invalid("header"));
        }
        Ok(p[42..].to_vec())
    }
}
pub fn nonce(s: &[u8; 32], d: u8, k: Kind, c: u64) -> [u8; 24] {
    let mut n = [0; 24];
    n[..12].copy_from_slice(&s[..12]);
    n[12..16].copy_from_slice(&[2, d, k as u8, 0]);
    n[16..].copy_from_slice(&c.to_be_bytes());
    n
}
fn header(s: &[u8; 32], d: u8, k: Kind, c: u64) -> Vec<u8> {
    [s.as_slice(), &[d, k as u8], &c.to_be_bytes()].concat()
}
pub struct Framer {
    keys: SessionKeys,
    rx: u64,
    tx: u64,
}
impl Framer {
    pub fn responder(keys: SessionKeys) -> Self {
        Self { keys, rx: 0, tx: 0 }
    }
    pub fn open(&mut self, k: Kind, f: &[u8]) -> Result<Vec<u8>> {
        let next = self
            .rx
            .checked_add(1)
            .ok_or(Error::Invalid("counter exhausted"))?;
        let p = self.keys.open_at(0, k, self.rx, f)?;
        self.rx = next;
        Ok(p)
    }
    pub fn seal(&mut self, k: Kind, p: &[u8]) -> Result<Vec<u8>> {
        let next = self
            .tx
            .checked_add(1)
            .ok_or(Error::Invalid("counter exhausted"))?;
        let f = self.keys.seal_at(1, k, self.tx, p)?;
        self.tx = next;
        Ok(f)
    }
    pub fn transcript_hash(&self) -> [u8; 32] {
        self.keys.transcript_hash
    }
}
pub fn transcript(
    ctx: &Context,
    cp: &[u8; 32],
    cn: &[u8; 32],
    dp: &[u8; 32],
    dn: &[u8; 32],
) -> Vec<u8> {
    fn field(out: &mut Vec<u8>, name: &str, v: &[u8]) {
        out.extend((name.len() as u32).to_be_bytes());
        out.extend(name.as_bytes());
        out.extend((v.len() as u32).to_be_bytes());
        out.extend(v);
    }
    let mut out = Vec::new();
    field(&mut out, "domain", TRANSCRIPT_DOMAIN.as_bytes());
    let kinds = [
        2u32.to_be_bytes().as_slice(),
        &4u32.to_be_bytes(),
        b"text",
        &6u32.to_be_bytes(),
        b"binary",
    ]
    .concat();
    for (prefix, typ, pk, n) in [
        ("mobile-to-desktop", "e2ee_hello", cp, cn),
        ("desktop-to-mobile", "e2ee_ready", dp, dn),
    ] {
        let mut add = |suffix: &str, v: &[u8]| field(&mut out, &format!("{prefix}.{suffix}"), v);
        add("type", typ.as_bytes());
        add("version", &2u32.to_be_bytes());
        if prefix == "mobile-to-desktop" {
            add("client-public-key", pk);
            add("client-nonce", n);
            add("capabilities.framing", &[0, 0, 0, 1, 0, 0, 0, 2]);
            add("capabilities.payload-kinds", &kinds);
        } else {
            add("desktop-public-key", pk);
            add("client-nonce-echo", cn);
            add("desktop-nonce", n);
            add("selection.framing", &2u32.to_be_bytes());
            add("selection.payload-kinds", &kinds);
        }
        for (key, v) in [
            ("protocol", PROTOCOL),
            ("initiator", "mobile"),
            ("responder", "desktop"),
            ("transport", ctx.transport()),
            ("relay-host-id", ctx.relay_host_id().unwrap_or("")),
        ] {
            add(&format!("context.{key}"), v.as_bytes());
        }
    }
    out
}
/// HSalsa20 with the zero 16-byte input used by crypto_box_beforenm.
/// Fixed 20 rounds; additions wrap modulo 2^32, and no feed-forward is applied.
pub(crate) fn before_nm(raw: [u8; 32]) -> [u8; 32] {
    let mut x = [0u32; 16];
    for (i, w) in [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]
        .into_iter()
        .enumerate()
    {
        x[i * 5] = w;
    }
    for (i, pos) in [1, 2, 3, 4, 11, 12, 13, 14].into_iter().enumerate() {
        x[pos] = u32::from_le_bytes(raw[i * 4..i * 4 + 4].try_into().unwrap());
    }
    fn quarter(x: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize) {
        x[b] ^= x[a].wrapping_add(x[d]).rotate_left(7);
        x[c] ^= x[b].wrapping_add(x[a]).rotate_left(9);
        x[d] ^= x[c].wrapping_add(x[b]).rotate_left(13);
        x[a] ^= x[d].wrapping_add(x[c]).rotate_left(18);
    }
    for _ in 0..10 {
        for (a, b, c, d) in [
            (0, 4, 8, 12),
            (5, 9, 13, 1),
            (10, 14, 2, 6),
            (15, 3, 7, 11),
            (0, 1, 2, 3),
            (5, 6, 7, 4),
            (10, 11, 8, 9),
            (15, 12, 13, 14),
        ] {
            quarter(&mut x, a, b, c, d)
        }
    }
    let mut out = [0; 32];
    for (i, p) in [0, 5, 10, 15, 6, 7, 8, 9].into_iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&x[p].to_le_bytes());
    }
    out
}
