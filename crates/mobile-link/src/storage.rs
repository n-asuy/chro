use crate::*;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
fn random<const N: usize>() -> [u8; N] {
    let mut b = [0; N];
    OsRng.fill_bytes(&mut b);
    b
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|v| format!("{v:02x}")).collect()
}
fn token() -> String {
    hex(&random::<24>())
}
fn id() -> String {
    let mut b = random::<16>();
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    let s = hex(&b);
    format!(
        "{}-{}-{}-{}-{}",
        &s[..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..]
    )
}
fn hash(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}
fn parent(p: &Path) -> &Path {
    p.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}
fn read_private(p: &Path) -> Result<Vec<u8>> {
    if !fs::symlink_metadata(p)?.file_type().is_file() {
        return Err(Error::Invalid("regular storage file"));
    }
    let mut f = fs::File::open(p)?;
    #[cfg(unix)]
    f.set_permissions(fs::Permissions::from_mode(0o600))?;
    let mut b = Vec::new();
    f.read_to_end(&mut b)?;
    Ok(b)
}
fn write_private(p: &Path, value: &impl Serialize) -> Result<()> {
    let par = parent(p);
    if !par.exists() {
        fs::create_dir_all(par)?;
        #[cfg(unix)]
        fs::set_permissions(par, fs::Permissions::from_mode(0o700))?;
    }
    let tmp = par.join(format!(".mobile-{}-{}.tmp", std::process::id(), token()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut f = options.open(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(value)?)?;
        f.sync_all()?;
        fs::rename(&tmp, p)?;
        fs::File::open(par)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
#[derive(Clone)]
pub struct HostKey {
    secret: [u8; 32],
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyFile {
    v: u8,
    public_key_b64: String,
    secret_key_b64: String,
}
impl HostKey {
    pub fn from_secret(secret: [u8; 32]) -> Self {
        Self { secret }
    }
    pub fn generate() -> Self {
        Self::from_secret(random())
    }
    pub fn public_key(&self) -> [u8; 32] {
        crypto_box::SecretKey::from(self.secret)
            .public_key()
            .to_bytes()
    }
    pub fn shared(&self, peer: [u8; 32]) -> Result<[u8; 32]> {
        let raw = x25519_dalek::StaticSecret::from(self.secret)
            .diffie_hellman(&x25519_dalek::PublicKey::from(peer));
        if !raw.was_contributory() {
            return Err(Error::Invalid("non-contributory public key"));
        }
        Ok(crate::crypto::before_nm(raw.to_bytes()))
    }
    pub fn persist(&self, p: impl AsRef<Path>) -> Result<()> {
        write_private(
            p.as_ref(),
            &KeyFile {
                v: 1,
                public_key_b64: STANDARD.encode(self.public_key()),
                secret_key_b64: STANDARD.encode(self.secret),
            },
        )
    }
    pub fn load(p: impl AsRef<Path>) -> Result<Self> {
        let k: KeyFile = serde_json::from_slice(&read_private(p.as_ref())?)?;
        if k.v != 1 {
            return Err(Error::Invalid("key version"));
        }
        b32(&k.public_key_b64)?;
        Ok(Self::from_secret(b32(&k.secret_key_b64)?))
    }
    pub fn load_or_generate(p: impl AsRef<Path>) -> Result<Self> {
        let p = p.as_ref();
        match Self::load(p) {
            Ok(k) => Ok(k),
            Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                // Refuse dangling symlinks rather than replace an unreadable identity.
                if fs::symlink_metadata(p).is_ok() {
                    return Err(Error::Io(e));
                }
                let k = Self::generate();
                k.persist(p)?;
                Ok(k)
            }
            Err(e) => Err(e),
        }
    }
}
impl Drop for HostKey {
    fn drop(&mut self) {
        self.secret.fill(0)
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub paired_at: u64,
    pub last_seen_at: Option<u64>,
    pub credential_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    offer_expires_at: Option<u64>,
    #[serde(default)]
    ticket: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    ticket_first_seen_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exchange_token_hash: Option<String>,
    /// Where the device last authenticated from, as the listener classifies
    /// sources (for example `loopback`, `private`, `tailnet`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_source: Option<String>,
}
/// How long a used QR ticket lasts, from its first use: the window to
/// exchange it for a device-chosen token, and the ticket's whole life. A
/// ticket that was never exchanged by then neither authenticates nor keeps a
/// connection standing; the phone pairs again with a new QR code.
pub const TICKET_EXCHANGE_WINDOW_MS: u64 = 600_000;
impl Device {
    /// True while the device's token is still the QR ticket.
    pub fn is_ticket(&self) -> bool {
        self.ticket
    }
    /// True when `token_hash` is this row's QR ticket and its window ended.
    fn ticket_expired(&self, token_hash: &str, now: u64) -> bool {
        self.ticket
            && eq(self.token_hash.as_bytes(), token_hash.as_bytes())
            && self
                .ticket_first_seen_at
                .is_some_and(|first| now.saturating_sub(first) >= TICKET_EXCHANGE_WINDOW_MS)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Credential {
    pub device_id: String,
    pub revision: u64,
    token_hash: String,
}
impl Credential {
    /// The credential a connection authenticated with, rebuilt from the
    /// device ID, revision and token it kept. `Registry::check` decides
    /// whether it still holds.
    pub fn for_token(device_id: &str, revision: u64, token: &str) -> Self {
        Self {
            device_id: device_id.to_owned(),
            revision,
            token_hash: hash(token),
        }
    }
}
pub struct Registry {
    path: PathBuf,
    rows: Vec<Device>,
}
impl Registry {
    pub fn open(p: impl AsRef<Path>) -> Result<Self> {
        let path = p.as_ref().to_owned();
        let rows = match read_private(&path) {
            Ok(b) => Self::parse(&b)?,
            Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e),
        };
        Ok(Self { path, rows })
    }
    fn parse(b: &[u8]) -> Result<Vec<Device>> {
        let rows: Vec<Device> = serde_json::from_slice(b)?;
        let mut ids = std::collections::HashSet::new();
        let mut hashes = std::collections::HashSet::new();
        for r in &rows {
            if r.id.is_empty()
                || r.name.is_empty()
                || !ids.insert(&r.id)
                || !valid_hash(&r.token_hash)
                || !hashes.insert(&r.token_hash)
                || r.credential_revision == 0
            {
                return Err(Error::Invalid("registry row"));
            }
            if let Some(h) = &r.exchange_token_hash {
                if !valid_hash(h) || !hashes.insert(h) {
                    return Err(Error::Invalid("pending token hash"));
                }
            }
        }
        Ok(rows)
    }
    fn refresh(&mut self) -> Result<()> {
        self.rows = Self::parse(&read_private(&self.path)?)?;
        Ok(())
    }
    fn refresh_for_write(&mut self) -> Result<()> {
        match self.refresh() {
            Err(Error::Io(e))
                if e.kind() == std::io::ErrorKind::NotFound && self.rows.is_empty() =>
            {
                Ok(())
            }
            r => r,
        }
    }
    fn commit(&mut self, rows: Vec<Device>) -> Result<()> {
        write_private(&self.path, &rows)?;
        self.rows = rows;
        Ok(())
    }
    pub fn devices(&self) -> &[Device] {
        &self.rows
    }
    pub fn authenticate(&mut self, t: &str, now: u64) -> Result<Credential> {
        self.refresh_for_write()?;
        let h = hash(t);
        let mut rows = self.rows.clone();
        let r = rows
            .iter_mut()
            .find(|r| {
                eq(r.token_hash.as_bytes(), h.as_bytes())
                    || r.exchange_token_hash
                        .as_ref()
                        .is_some_and(|x| eq(x.as_bytes(), h.as_bytes()))
            })
            .ok_or(Error::Protocol("unauthorized"))?;
        if r.offer_expires_at.is_some_and(|e| now >= e) || r.ticket_expired(&h, now) {
            return Err(Error::Protocol("unauthorized"));
        }
        if r.exchange_token_hash.as_ref() == Some(&h) {
            r.token_hash = h.clone();
            r.exchange_token_hash = None;
            r.ticket = false;
            r.credential_revision = r
                .credential_revision
                .checked_add(1)
                .ok_or(Error::Invalid("credential revision"))?;
        }
        if r.ticket_first_seen_at.is_none() && r.ticket {
            r.ticket_first_seen_at = Some(now);
        }
        r.last_seen_at = Some(now);
        r.offer_expires_at = None;
        let c = Credential {
            device_id: r.id.clone(),
            revision: r.credential_revision,
            token_hash: h,
        };
        self.commit(rows)?;
        Ok(c)
    }
    /// Reload from disk on every frame; missing, changed and unreadable rows
    /// fail closed, as does a QR ticket past its exchange window.
    pub fn check(&mut self, c: &Credential, now: u64) -> Result<()> {
        self.refresh()?;
        if self.rows.iter().any(|r| {
            r.id == c.device_id
                && r.credential_revision == c.revision
                && eq(r.token_hash.as_bytes(), c.token_hash.as_bytes())
                && !r.ticket_expired(&c.token_hash, now)
        }) {
            Ok(())
        } else {
            Err(Error::Protocol("device_revoked"))
        }
    }
    /// Remember where `c`'s device connected from. Writes only on change;
    /// a credential that no longer holds fails like `check`.
    pub fn record_source(&mut self, c: &Credential, source: &str, now: u64) -> Result<()> {
        self.check(c, now)?;
        let mut rows = self.rows.clone();
        let r = rows
            .iter_mut()
            .find(|r| r.id == c.device_id)
            .ok_or(Error::Protocol("device_revoked"))?;
        if r.last_source.as_deref() == Some(source) {
            return Ok(());
        }
        r.last_source = Some(source.to_owned());
        self.commit(rows)
    }
    pub fn matches_token(&self, c: &Credential, t: &str) -> bool {
        eq(c.token_hash.as_bytes(), hash(t).as_bytes())
    }
    pub fn revoke(&mut self, id: &str) -> Result<bool> {
        self.refresh_for_write()?;
        let rows: Vec<_> = self.rows.iter().filter(|r| r.id != id).cloned().collect();
        let changed = rows.len() != self.rows.len();
        if changed {
            self.commit(rows)?
        }
        Ok(changed)
    }
    /// Propose `new` as the token replacing the ticket `c` authenticated with.
    /// Repeating the same proposal answers the same device ID, so a phone
    /// that lost the reply retries with the token it proposed, or simply
    /// authenticates with it (which commits the exchange, also after the
    /// ticket expired).
    pub fn exchange_ticket(&mut self, c: &Credential, new: &str, now: u64) -> Result<String> {
        self.check(c, now)?;
        if !(48..=128).contains(&new.len())
            || !new
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Protocol("invalid_argument"));
        }
        let h = hash(new);
        let mut rows = self.rows.clone();
        let r = rows.iter().find(|r| r.id == c.device_id).unwrap();
        if !r.ticket {
            return Err(Error::Protocol("not_a_ticket"));
        }
        if now.saturating_sub(
            r.ticket_first_seen_at
                .ok_or(Error::Protocol("ticket_window_closed"))?,
        ) >= TICKET_EXCHANGE_WINDOW_MS
        {
            return Err(Error::Protocol("ticket_window_closed"));
        }
        if let Some(old) = &r.exchange_token_hash {
            if old == &h {
                return Ok(r.id.clone());
            }
            return Err(Error::Protocol("ticket_exchange_pending"));
        }
        if rows
            .iter()
            .any(|r| r.token_hash == h || r.exchange_token_hash.as_ref() == Some(&h))
        {
            return Err(Error::Protocol("device_token_in_use"));
        }
        let r = rows.iter_mut().find(|r| r.id == c.device_id).unwrap();
        r.exchange_token_hash = Some(h);
        let id = r.id.clone();
        self.commit(rows)?;
        Ok(id)
    }
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingOffer {
    pub v: u8,
    pub endpoint: String,
    pub device_token: String,
    pub public_key_b64: String,
    pub paired_device_id: String,
    pub scope: String,
}
#[derive(Clone, Debug)]
pub struct IssuedOffer {
    pub offer: PairingOffer,
    pub pairing_url: String,
    pub qr_svg: String,
    pub expires_at: u64,
}
#[derive(Default)]
pub struct Offers {
    current: Option<IssuedOffer>,
}
impl Offers {
    pub fn issue(
        &mut self,
        r: &mut Registry,
        h: &HostKey,
        endpoint: &str,
        name: &str,
        now: u64,
        rotate: bool,
    ) -> Result<IssuedOffer> {
        validate_endpoint(endpoint)?;
        if name.is_empty() {
            return Err(Error::Invalid("device name"));
        }
        r.refresh_for_write()?;
        if !rotate {
            if let Some(o) = &self.current {
                if o.expires_at.saturating_sub(now) > 60000
                    && o.offer.endpoint == endpoint
                    && o.offer.public_key_b64 == STANDARD.encode(h.public_key())
                    && r.rows
                        .iter()
                        .any(|r| r.id == o.offer.paired_device_id && r.last_seen_at.is_none())
                {
                    return Ok(o.clone());
                }
            }
        }
        let expires = now.checked_add(600000).ok_or(Error::Invalid("expiry"))?;
        let t = token();
        let device = Device {
            id: id(),
            name: name.to_owned(),
            token_hash: hash(&t),
            paired_at: now,
            last_seen_at: None,
            credential_revision: 1,
            offer_expires_at: Some(expires),
            ticket: true,
            ticket_first_seen_at: None,
            exchange_token_hash: None,
            last_source: None,
        };
        let offer = PairingOffer {
            v: 2,
            endpoint: endpoint.to_owned(),
            device_token: t,
            public_key_b64: STANDARD.encode(h.public_key()),
            paired_device_id: device.id.clone(),
            scope: "mobile".into(),
        };
        let url = format!(
            "chro://pair?code={}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&offer)?)
        );
        let qr = qrcode::QrCode::with_error_correction_level(url.as_bytes(), qrcode::EcLevel::M)
            .map_err(|_| Error::Invalid("QR capacity"))?;
        let svg = qr
            .render::<qrcode::render::svg::Color>()
            .quiet_zone(true)
            .module_dimensions(2, 2)
            .build();
        let mut rows: Vec<_> = r
            .rows
            .iter()
            .filter(|r| r.last_seen_at.is_some())
            .cloned()
            .collect();
        rows.push(device);
        r.commit(rows)?;
        let o = IssuedOffer {
            offer,
            pairing_url: url,
            qr_svg: svg,
            expires_at: expires,
        };
        self.current = Some(o.clone());
        Ok(o)
    }
}
fn validate_endpoint(s: &str) -> Result<()> {
    let rest = s
        .strip_prefix("ws://")
        .or_else(|| s.strip_prefix("wss://"))
        .ok_or(Error::Invalid("endpoint scheme"))?;
    if s.len() > 16384
        || rest.is_empty()
        || rest.contains(['/', '?', '#', '@'])
        || rest.chars().any(char::is_whitespace)
        || rest.starts_with(['*', ':'])
        || rest == "0.0.0.0"
        || rest.starts_with("0.0.0.0:")
        || rest.starts_with("[::]")
    {
        return Err(Error::Invalid("endpoint"));
    }
    let port = if rest.starts_with('[') {
        let end = rest.find(']').ok_or(Error::Invalid("IPv6 endpoint"))?;
        rest[1..end]
            .parse::<std::net::Ipv6Addr>()
            .map_err(|_| Error::Invalid("IPv6 endpoint"))?;
        let tail = &rest[end + 1..];
        if tail.is_empty() {
            None
        } else {
            Some(tail.strip_prefix(':').ok_or(Error::Invalid("port"))?)
        }
    } else {
        if rest.matches(':').count() > 1 {
            return Err(Error::Invalid("IPv6 brackets"));
        }
        rest.split_once(':').map(|(_, p)| p)
    };
    if let Some(p) = port {
        if p.parse::<u16>().ok().filter(|p| *p > 0).is_none() {
            return Err(Error::Invalid("port"));
        }
    }
    Ok(())
}
