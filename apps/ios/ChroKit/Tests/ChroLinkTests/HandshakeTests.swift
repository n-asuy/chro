import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// The initiator's validation of `e2ee_ready` and of the sealed answer to `e2ee_auth`.
struct HandshakeTests {
    let hostSecret = Data(repeating: 0x21, count: 32)
    let hostPublic: Data
    let clientSecret = Data(repeating: 0x31, count: 32)
    let clientNonce = Data(repeating: 0x02, count: 32)
    let desktopNonce = Data(repeating: 0x04, count: 32)
    let token = String(repeating: "c", count: 48)

    init() throws { hostPublic = try NaCl.publicKey(secretKey: hostSecret) }

    private func initiator(pinned: Data? = nil) throws -> HandshakeInitiator {
        try HandshakeInitiator(context: .direct, pinnedHostKey: pinned ?? hostPublic, deviceToken: token, clientSecretKey: clientSecret, clientNonce: clientNonce)
    }

    private func readyObject() -> [String: Any] {
        [
            "type": "e2ee_ready", "v": 2,
            "desktopPublicKeyB64": hostPublic.base64EncodedString(),
            "clientNonceB64": clientNonce.base64EncodedString(),
            "desktopNonceB64": desktopNonce.base64EncodedString(),
            "selection": ["framing": 2, "payloadKinds": ["text", "binary"]],
            "context": ["protocol": "chro-mobile-e2ee", "initiator": "mobile", "responder": "desktop", "transport": "direct"],
        ]
    }

    private func text(_ object: [String: Any]) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    /// Keys as the host derives them for this ready.
    private func hostKeys(clientPublic: Data) throws -> SessionKeys {
        let shared = try NaCl.boxBeforeNM(publicKey: clientPublic, secretKey: hostSecret)
        let transcript = Transcript.encode(context: .direct, clientPublicKey: clientPublic, clientNonce: clientNonce, desktopPublicKey: hostPublic, desktopNonce: desktopNonce)
        return KeySchedule.derive(shared: shared, clientNonce: clientNonce, desktopNonce: desktopNonce, transcript: transcript)
    }

    @Test func helloIsTheExactContract() throws {
        let handshake = try initiator()
        let clientPublic = try NaCl.publicKey(secretKey: clientSecret)
        #expect(handshake.hello == "{\"type\":\"e2ee_hello\",\"v\":2,\"clientPublicKeyB64\":\"\(clientPublic.base64EncodedString())\",\"clientNonceB64\":\"\(clientNonce.base64EncodedString())\",\"capabilities\":{\"framing\":[2],\"payloadKinds\":[\"text\",\"binary\"]},\"context\":{\"protocol\":\"chro-mobile-e2ee\",\"initiator\":\"mobile\",\"responder\":\"desktop\",\"transport\":\"direct\"}}")
        let relay = try HandshakeInitiator(context: .relay(hostId: "AbCdEf0123_-xyZ9"), pinnedHostKey: hostPublic, deviceToken: token, clientSecretKey: clientSecret, clientNonce: clientNonce)
        #expect(relay.hello.hasSuffix("\"transport\":\"relay\",\"relayHostId\":\"AbCdEf0123_-xyZ9\"}}"))
    }

    @Test func successfulHandshakeDerivesTheHostsKeys() throws {
        var handshake = try initiator()
        let authText = try handshake.receiveReady(text(readyObject()))
        let keys = try hostKeys(clientPublic: handshake.clientPublicKey)
        #expect(handshake.keys == keys)
        // The host opens auth with counter 0 and sees our transcript hash and token.
        var hostOpener = FrameOpener(keys: keys, direction: .mobileToDesktop)
        let auth = try hostOpener.open(kind: .text, frame: try CanonicalBase64.decode(authText))
        #expect(auth == HandshakeMessages.auth(transcriptHash: keys.transcriptHash, deviceToken: token))
        var hostSealer = FrameSealer(keys: keys, direction: .desktopToMobile)
        let ok = try hostSealer.seal(kind: .text, payload: Data("{\"type\":\"e2ee_authenticated\",\"v\":2,\"transcriptHashB64\":\"\(keys.transcriptHash.base64EncodedString())\"}".utf8))
        try handshake.receiveAuthenticated(ok.base64EncodedString())
        // After auth, the phone's next frame is counter 1 and the host's is counter 1.
        #expect(handshake.sealer?.nextCounter == 1)
        #expect(handshake.opener?.expectedCounter == 1)
    }

    @Test(arguments: [
        ReadyEdit("extra key") { o in o["extra"] = 1 },
        ReadyEdit("missing key") { o in o.removeValue(forKey: "desktopNonceB64") },
        ReadyEdit("type") { o in o["type"] = "e2ee_hello" },
        ReadyEdit("v=1") { o in o["v"] = 1 },
        ReadyEdit("v string") { o in o["v"] = "2" },
        ReadyEdit("v bool") { o in o["v"] = true },
        ReadyEdit("v fraction") { o in o["v"] = 2.5 },
        ReadyEdit("selection framing") { o in o["selection"] = ["framing": 1, "payloadKinds": ["text", "binary"]] },
        ReadyEdit("selection framing list") { o in o["selection"] = ["framing": [2], "payloadKinds": ["text", "binary"]] },
        ReadyEdit("selection kinds order") { o in o["selection"] = ["framing": 2, "payloadKinds": ["binary", "text"]] },
        ReadyEdit("selection kinds subset") { o in o["selection"] = ["framing": 2, "payloadKinds": ["text"]] },
        ReadyEdit("selection extra key") { o in o["selection"] = ["framing": 2, "payloadKinds": ["text", "binary"], "x": 1] },
        ReadyEdit("context protocol") { o in o["context"] = ["protocol": "other-mobile-e2ee", "initiator": "mobile", "responder": "desktop", "transport": "direct"] },
        ReadyEdit("context initiator") { o in o["context"] = ["protocol": "chro-mobile-e2ee", "initiator": "desktop", "responder": "desktop", "transport": "direct"] },
        ReadyEdit("context transport") { o in o["context"] = ["protocol": "chro-mobile-e2ee", "initiator": "mobile", "responder": "desktop", "transport": "relay"] },
        ReadyEdit("context relayHostId on direct") { o in o["context"] = ["protocol": "chro-mobile-e2ee", "initiator": "mobile", "responder": "desktop", "transport": "direct", "relayHostId": "AbCdEf0123_-xyZ9"] },
        ReadyEdit("context missing") { o in o["context"] = ["protocol": "chro-mobile-e2ee", "initiator": "mobile", "responder": "desktop"] },
        ReadyEdit("nonce echo") { o in o["clientNonceB64"] = Data(repeating: 3, count: 32).base64EncodedString() },
        ReadyEdit("echo without padding") { o in o["clientNonceB64"] = String(Data(repeating: 2, count: 32).base64EncodedString().dropLast()) },
        ReadyEdit("desktop nonce short") { o in o["desktopNonceB64"] = Data(repeating: 4, count: 31).base64EncodedString() },
        ReadyEdit("desktop nonce base64url") { o in o["desktopNonceB64"] = Data(repeating: 0xFB, count: 32).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_") },
        ReadyEdit("desktop key not base64") { o in o["desktopPublicKeyB64"] = "not base64!" },
        ReadyEdit("desktop key number") { o in o["desktopPublicKeyB64"] = 7 },
    ])
    func invalidReadyIsRejected(_ edit: ReadyEdit) throws {
        var handshake = try initiator()
        var object = readyObject()
        edit.apply(&object)
        #expect(throws: HandshakeError.self, "\(edit.name)") { try handshake.receiveReady(text(object)) }
        #expect(handshake.keys == nil)
    }

    @Test func readyThatIsNotJSONIsRejected() throws {
        var handshake = try initiator()
        #expect(throws: HandshakeError.invalidReady("not a JSON object")) { try handshake.receiveReady("hello") }
        #expect(throws: HandshakeError.invalidReady("not a JSON object")) { try handshake.receiveReady("[]") }
    }

    @Test func hostKeyMustBeThePinnedOne() throws {
        let other = try NaCl.publicKey(secretKey: Data(repeating: 0x77, count: 32))
        var handshake = try initiator(pinned: other)
        #expect(throws: HandshakeError.hostKeyMismatch) { try handshake.receiveReady(text(readyObject())) }
    }

    @Test func plaintextErrorInsteadOfReadyIsARejection() throws {
        var handshake = try initiator()
        #expect(throws: HandshakeError.rejected(code: "bad_auth")) {
            try handshake.receiveReady("{\"type\":\"e2ee_error\",\"error\":{\"code\":\"bad_auth\"}}")
        }
    }

    // MARK: Answer to auth

    private func readied() throws -> (HandshakeInitiator, FrameSealer, SessionKeys) {
        var handshake = try initiator()
        _ = try handshake.receiveReady(text(readyObject()))
        let keys = try hostKeys(clientPublic: handshake.clientPublicKey)
        return (handshake, FrameSealer(keys: keys, direction: .desktopToMobile), keys)
    }

    @Test func sealedErrorIsARejectionWithItsCode() throws {
        for code in ["unauthorized", "device_revoked", "registry_unavailable", "bad_auth"] {
            var (handshake, sealer, _) = try readied()
            let frame = try sealer.seal(kind: .text, payload: Data("{\"type\":\"e2ee_error\",\"error\":{\"code\":\"\(code)\",\"deviceId\":\"d\"}}".utf8))
            #expect(throws: HandshakeError.rejected(code: code)) { try handshake.receiveAuthenticated(frame.base64EncodedString()) }
        }
    }

    @Test func authenticatedMustBindOurTranscript() throws {
        var (handshake, sealer, _) = try readied()
        let frame = try sealer.seal(kind: .text, payload: Data("{\"type\":\"e2ee_authenticated\",\"v\":2,\"transcriptHashB64\":\"\(Data(repeating: 1, count: 32).base64EncodedString())\"}".utf8))
        #expect(throws: HandshakeError.self) { try handshake.receiveAuthenticated(frame.base64EncodedString()) }
    }

    @Test func authenticatedWithExtraKeysOrWrongVersionIsRejected() throws {
        for body in [
            "{\"type\":\"e2ee_authenticated\",\"v\":2,\"transcriptHashB64\":\"HASH\",\"x\":1}",
            "{\"type\":\"e2ee_authenticated\",\"v\":1,\"transcriptHashB64\":\"HASH\"}",
            "{\"type\":\"e2ee_ready\",\"v\":2,\"transcriptHashB64\":\"HASH\"}",
        ] {
            var (handshake, sealer, keys) = try readied()
            let frame = try sealer.seal(kind: .text, payload: Data(body.replacingOccurrences(of: "HASH", with: keys.transcriptHash.base64EncodedString()).utf8))
            #expect(throws: HandshakeError.self, "\(body)") { try handshake.receiveAuthenticated(frame.base64EncodedString()) }
        }
    }

    @Test func authenticatedMustBeTheHostsCounterZeroFrame() throws {
        var (handshake, sealer, keys) = try readied()
        let ok = Data("{\"type\":\"e2ee_authenticated\",\"v\":2,\"transcriptHashB64\":\"\(keys.transcriptHash.base64EncodedString())\"}".utf8)
        _ = try sealer.seal(kind: .text, payload: ok)  // counter 0 dropped: a gap
        let gap = try sealer.seal(kind: .text, payload: ok)
        #expect(throws: HandshakeError.invalidAuthenticated("frame does not open")) { try handshake.receiveAuthenticated(gap.base64EncodedString()) }
        // Our own auth frame reflected back must not pass either.
        var (fresh, _, _) = try readied()
        var reflectedSource = try initiator()
        let reflected = try reflectedSource.receiveReady(text(readyObject()))
        #expect(throws: HandshakeError.self) { try fresh.receiveAuthenticated(reflected) }
    }

    @Test func authenticatedBeforeReadyIsRejected() throws {
        var handshake = try initiator()
        #expect(throws: HandshakeError.self) { try handshake.receiveAuthenticated("AAAA") }
    }
}

/// One broken variant of `e2ee_ready`.
struct ReadyEdit: Sendable, CustomTestStringConvertible {
    let name: String
    let apply: @Sendable (inout [String: Any]) -> Void

    init(_ name: String, _ apply: @escaping @Sendable (inout [String: Any]) -> Void) {
        self.name = name
        self.apply = apply
    }

    var testDescription: String { name }
}
