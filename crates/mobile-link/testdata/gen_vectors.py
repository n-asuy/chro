"""Generate the chro mobile E2EE v2 test vectors (labels are chro's own).

Run: uv run --with pynacl python gen_vectors.py <out.json>
Every value is derived here with libsodium (PyNaCl) and stdlib HMAC/SHA-256, so the
Rust (crates/mobile-link) and Swift (ChroKit/ChroLink) implementations must both
reproduce it byte for byte.
"""
import base64, hashlib, hmac, json, struct, sys
from nacl.bindings import crypto_box_beforenm, crypto_scalarmult_base, crypto_secretbox

PROTOCOL = "chro-mobile-e2ee"
TRANSCRIPT_DOMAIN = b"chro-mobile-e2ee/v2/transcript"
SALT_LABEL = b"chro-mobile-e2ee/v2/salt\0"
SESSION_LABEL = b"chro-mobile-e2ee/v2/session\0"

u32 = lambda n: struct.pack(">I", n)
utf8 = lambda s: s.encode("utf-8")
def str_list(v): return u32(len(v)) + b"".join(u32(len(utf8(x))) + utf8(x) for x in v)
def num_list(v): return u32(len(v)) + b"".join(u32(x) for x in v)

def transcript(ctx, client_pk, client_nonce, desktop_pk, desktop_nonce):
    rid = ctx.get("relayHostId", "")
    fields = [("domain", TRANSCRIPT_DOMAIN),
        ("mobile-to-desktop.type", utf8("e2ee_hello")), ("mobile-to-desktop.version", u32(2)),
        ("mobile-to-desktop.client-public-key", client_pk), ("mobile-to-desktop.client-nonce", client_nonce),
        ("mobile-to-desktop.capabilities.framing", num_list([2])),
        ("mobile-to-desktop.capabilities.payload-kinds", str_list(["text", "binary"]))]
    fields += [(f"mobile-to-desktop.context.{k}", utf8(v)) for k, v in
        [("protocol", ctx["protocol"]), ("initiator", "mobile"), ("responder", "desktop"), ("transport", ctx["transport"]), ("relay-host-id", rid)]]
    fields += [("desktop-to-mobile.type", utf8("e2ee_ready")), ("desktop-to-mobile.version", u32(2)),
        ("desktop-to-mobile.desktop-public-key", desktop_pk), ("desktop-to-mobile.client-nonce-echo", client_nonce),
        ("desktop-to-mobile.desktop-nonce", desktop_nonce), ("desktop-to-mobile.selection.framing", u32(2)),
        ("desktop-to-mobile.selection.payload-kinds", str_list(["text", "binary"]))]
    fields += [(f"desktop-to-mobile.context.{k}", utf8(v)) for k, v in
        [("protocol", ctx["protocol"]), ("initiator", "mobile"), ("responder", "desktop"), ("transport", ctx["transport"]), ("relay-host-id", rid)]]
    return b"".join(u32(len(utf8(n))) + utf8(n) + u32(len(v)) + v for n, v in fields)

def schedule(shared, client_nonce, desktop_nonce, th):
    salt = hashlib.sha256(SALT_LABEL + client_nonce + desktop_nonce).digest()
    prk = hmac.new(salt, shared, hashlib.sha256).digest()
    okm, t = b"", b""
    for i in range(1, 4):
        t = hmac.new(prk, t + SESSION_LABEL + th + bytes([i]), hashlib.sha256).digest()
        okm += t
    return okm[0:32], okm[32:64], okm[64:96]

def nonce(session_id, direction, kind, counter):
    return session_id[:12] + bytes([2, direction, kind, 0]) + struct.pack(">Q", counter)

def frame(key, session_id, direction, kind, counter, payload):
    n = nonce(session_id, direction, kind, counter)
    header = session_id + bytes([direction, kind]) + struct.pack(">Q", counter)
    return n + crypto_secretbox(header + payload, n, key)

hx = lambda b: b.hex()
out = {"labels": {"protocol": PROTOCOL, "transcriptDomain": TRANSCRIPT_DOMAIN.decode(), "salt": SALT_LABEL.decode(), "session": SESSION_LABEL.decode()}, "keySchedule": []}

# Fixed-input schedule vectors (no curve maths), both transports.
cpk, cn, dpk, dn, shared = bytes([1])*32, bytes([2])*32, bytes([3])*32, bytes([4])*32, bytes([5])*32
for ctx in [{"protocol": PROTOCOL, "transport": "direct"}, {"protocol": PROTOCOL, "transport": "relay", "relayHostId": "AbCdEf0123_-xyZ9"}]:
    tr = transcript(ctx, cpk, cn, dpk, dn); th = hashlib.sha256(tr).digest()
    m2d, d2m, sid = schedule(shared, cn, dn, th)
    out["keySchedule"].append({"context": ctx, "clientPublicKeyHex": hx(cpk), "clientNonceHex": hx(cn), "desktopPublicKeyHex": hx(dpk), "desktopNonceHex": hx(dn), "sharedHex": hx(shared),
        "transcriptLength": len(tr), "transcriptHex": hx(tr), "transcriptHashHex": hx(th), "mobileToDesktopKeyHex": hx(m2d), "desktopToMobileKeyHex": hx(d2m), "sessionIdHex": hx(sid)})

# End-to-end vector with real X25519 keys: beforenm on both sides, schedule, and frames.
client_sk, desktop_sk = bytes(range(1, 33)), bytes(range(33, 65))
client_pk, desktop_pk = crypto_scalarmult_base(client_sk), crypto_scalarmult_base(desktop_sk)
s1, s2 = crypto_box_beforenm(desktop_pk, client_sk), crypto_box_beforenm(client_pk, desktop_sk)
assert s1 == s2
ctx = {"protocol": PROTOCOL, "transport": "direct"}
tr = transcript(ctx, client_pk, cn, desktop_pk, dn); th = hashlib.sha256(tr).digest()
m2d, d2m, sid = schedule(s1, cn, dn, th)
auth = json.dumps({"type": "e2ee_auth", "v": 2, "transcriptHashB64": base64.b64encode(th).decode(), "deviceToken": "a" * 48}, separators=(",", ":")).encode()
rpc = json.dumps({"id": "rpc-1-1800000000000", "ok": True, "result": {}}, separators=(",", ":")).encode()
out["endToEnd"] = {"context": ctx, "clientSecretKeyHex": hx(client_sk), "clientPublicKeyHex": hx(client_pk), "desktopSecretKeyHex": hx(desktop_sk), "desktopPublicKeyHex": hx(desktop_pk),
    "clientNonceHex": hx(cn), "desktopNonceHex": hx(dn), "sharedHex": hx(s1), "transcriptHashHex": hx(th),
    "mobileToDesktopKeyHex": hx(m2d), "desktopToMobileKeyHex": hx(d2m), "sessionIdHex": hx(sid),
    "frames": [
        {"direction": 0, "kind": 0, "counter": 0, "payloadUtf8": auth.decode(), "frameHex": hx(frame(m2d, sid, 0, 0, 0, auth)), "frameB64": base64.b64encode(frame(m2d, sid, 0, 0, 0, auth)).decode()},
        {"direction": 1, "kind": 0, "counter": 0, "payloadUtf8": rpc.decode(), "frameHex": hx(frame(d2m, sid, 1, 0, 0, rpc)), "frameB64": base64.b64encode(frame(d2m, sid, 1, 0, 0, rpc)).decode()},
        {"direction": 1, "kind": 1, "counter": 1, "payloadHex": hx(bytes(range(16))), "frameHex": hx(frame(d2m, sid, 1, 1, 1, bytes(range(16))))},
    ]}
out["nonce"] = {"sessionIdHex": hx(bytes([8])*32), "direction": 0, "kind": 0, "counter": 0, "nonceHex": hx(nonce(bytes([8])*32, 0, 0, 0))}
out["frameOverheadBytes"] = 24 + 16 + 42
json.dump(out, open(sys.argv[1], "w"), indent=2); print("wrote", sys.argv[1], "overhead", out["frameOverheadBytes"])
