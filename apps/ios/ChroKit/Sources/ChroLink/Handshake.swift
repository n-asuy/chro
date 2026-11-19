import Foundation

/// Why a handshake did not authenticate. Every case is a rejection for the
/// purpose of the "three rejections in a row" rule (spec §2.6).
public enum HandshakeError: Error, Equatable, Sendable {
    /// `e2ee_ready` broke the contract (keys, values, encodings, echo, context).
    case invalidReady(String)
    /// `e2ee_ready.desktopPublicKeyB64` is not the key pinned by the QR.
    case hostKeyMismatch
    /// The host answered `e2ee_error` with this code (`unauthorized`, `device_revoked`, ...).
    case rejected(code: String)
    /// The sealed answer to `e2ee_auth` did not open or was not `e2ee_authenticated` for our transcript.
    case invalidAuthenticated(String)
    /// The host sent a binary message before the handshake finished.
    case unexpectedBinary
    /// The host closed the socket before the handshake finished.
    case closedByHost(code: Int, reason: String)
}

/// Wire text of the handshake messages, in the key order of spec §3.2.
enum HandshakeMessages {
    static let version = 2
    static let framing = 2
    static let payloadKinds = ["text", "binary"]
    static let helloType = "e2ee_hello"
    static let readyType = "e2ee_ready"
    static let authType = "e2ee_auth"
    static let authenticatedType = "e2ee_authenticated"
    static let errorType = "e2ee_error"

    static func hello(clientPublicKey: Data, clientNonce: Data, context: HandshakeContext) -> String {
        var contextText = "{\"protocol\":\(quote(E2EELabels.protocolName)),\"initiator\":\(quote(HandshakeContext.initiator)),\"responder\":\(quote(HandshakeContext.responder)),\"transport\":\(quote(context.transport))"
        if let relayHostId = context.relayHostId { contextText += ",\"relayHostId\":\(quote(relayHostId))" }
        contextText += "}"
        return "{\"type\":\(quote(helloType)),\"v\":\(version),\"clientPublicKeyB64\":\(quote(clientPublicKey.base64EncodedString())),\"clientNonceB64\":\(quote(clientNonce.base64EncodedString())),\"capabilities\":{\"framing\":[\(framing)],\"payloadKinds\":[\"text\",\"binary\"]},\"context\":\(contextText)}"
    }

    static func auth(transcriptHash: Data, deviceToken: String) -> Data {
        Data("{\"type\":\(quote(authType)),\"v\":\(version),\"transcriptHashB64\":\(quote(transcriptHash.base64EncodedString())),\"deviceToken\":\(quote(deviceToken))}".utf8)
    }

    /// A JSON string literal.
    static func quote(_ text: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [text], options: [.withoutEscapingSlashes])
        return String(decoding: data.dropFirst().dropLast(), as: UTF8.self)
    }
}

/// The phone's side of the E2EE v2 handshake as a pure state machine; the
/// socket work is done by the caller.
struct HandshakeInitiator {
    let context: HandshakeContext
    let pinnedHostKey: Data
    let deviceToken: String
    let clientSecretKey: Data
    let clientPublicKey: Data
    let clientNonce: Data
    private(set) var keys: SessionKeys?
    private(set) var sealer: FrameSealer?
    private(set) var opener: FrameOpener?

    init(context: HandshakeContext, pinnedHostKey: Data, deviceToken: String, clientSecretKey: Data, clientNonce: Data) throws {
        self.context = context
        self.pinnedHostKey = pinnedHostKey
        self.deviceToken = deviceToken
        self.clientSecretKey = clientSecretKey
        self.clientPublicKey = try NaCl.publicKey(secretKey: clientSecretKey)
        self.clientNonce = clientNonce
    }

    var hello: String {
        HandshakeMessages.hello(clientPublicKey: clientPublicKey, clientNonce: clientNonce, context: context)
    }

    /// Validates `e2ee_ready`, derives the session keys and returns the sealed
    /// `e2ee_auth` frame (counter 0), base64 for a WebSocket text message.
    mutating func receiveReady(_ text: String) throws -> String {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else {
            throw HandshakeError.invalidReady("not a JSON object")
        }
        if JSONShape.isString(object["type"], equalTo: HandshakeMessages.errorType) {
            throw HandshakeError.rejected(code: Self.errorCode(object))
        }
        let expectedKeys: Set = ["type", "v", "desktopPublicKeyB64", "clientNonceB64", "desktopNonceB64", "selection", "context"]
        guard JSONShape.keys(object) == expectedKeys else { throw HandshakeError.invalidReady("keys") }
        guard JSONShape.isString(object["type"], equalTo: HandshakeMessages.readyType) else { throw HandshakeError.invalidReady("type") }
        guard JSONShape.isInteger(object["v"], equalTo: HandshakeMessages.version) else { throw HandshakeError.invalidReady("v") }
        guard let selection = object["selection"] as? [String: Any], JSONShape.keys(selection) == ["framing", "payloadKinds"],
              JSONShape.isInteger(selection["framing"], equalTo: HandshakeMessages.framing),
              (selection["payloadKinds"] as? [Any]).map(Self.isPayloadKinds) == true
        else { throw HandshakeError.invalidReady("selection") }
        guard let readyContext = object["context"] as? [String: Any], Self.contextMatches(readyContext, context) else {
            throw HandshakeError.invalidReady("context")
        }
        guard let desktopKeyText = object["desktopPublicKeyB64"] as? String,
              let desktopKey = try? CanonicalBase64.decode(desktopKeyText, count: 32) else { throw HandshakeError.invalidReady("desktopPublicKeyB64") }
        guard let echoText = object["clientNonceB64"] as? String,
              let echo = try? CanonicalBase64.decode(echoText, count: 32) else { throw HandshakeError.invalidReady("clientNonceB64") }
        guard let desktopNonceText = object["desktopNonceB64"] as? String,
              let desktopNonce = try? CanonicalBase64.decode(desktopNonceText, count: 32) else { throw HandshakeError.invalidReady("desktopNonceB64") }
        guard NaCl.constantTimeEqual(echo, clientNonce) else { throw HandshakeError.invalidReady("clientNonceB64 echo") }
        // The QR is the only trust anchor: never accept a key it did not carry.
        guard NaCl.constantTimeEqual(desktopKey, pinnedHostKey) else { throw HandshakeError.hostKeyMismatch }

        let shared: Data
        do {
            shared = try NaCl.boxBeforeNM(publicKey: desktopKey, secretKey: clientSecretKey)
        } catch {
            throw HandshakeError.invalidReady("desktop key")
        }
        let transcript = Transcript.encode(context: context, clientPublicKey: clientPublicKey, clientNonce: clientNonce, desktopPublicKey: desktopKey, desktopNonce: desktopNonce)
        let keys = KeySchedule.derive(shared: shared, clientNonce: clientNonce, desktopNonce: desktopNonce, transcript: transcript)
        var sealer = FrameSealer(keys: keys, direction: .mobileToDesktop)
        let frame = try sealer.seal(kind: .text, payload: HandshakeMessages.auth(transcriptHash: keys.transcriptHash, deviceToken: deviceToken))
        self.keys = keys
        self.sealer = sealer
        self.opener = FrameOpener(keys: keys, direction: .desktopToMobile)
        return frame.base64EncodedString()
    }

    /// Opens the host's sealed answer to `e2ee_auth` and checks it binds our transcript.
    mutating func receiveAuthenticated(_ text: String) throws {
        guard var opener, let keys else { throw HandshakeError.invalidAuthenticated("ready not received") }
        guard let frame = try? CanonicalBase64.decode(text), let payload = try? opener.open(kind: .text, frame: frame) else {
            throw HandshakeError.invalidAuthenticated("frame does not open")
        }
        self.opener = opener
        guard let object = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] else {
            throw HandshakeError.invalidAuthenticated("not a JSON object")
        }
        if JSONShape.isString(object["type"], equalTo: HandshakeMessages.errorType) {
            throw HandshakeError.rejected(code: Self.errorCode(object))
        }
        guard JSONShape.keys(object) == ["type", "v", "transcriptHashB64"],
              JSONShape.isString(object["type"], equalTo: HandshakeMessages.authenticatedType),
              JSONShape.isInteger(object["v"], equalTo: HandshakeMessages.version),
              let hashText = object["transcriptHashB64"] as? String,
              let hash = try? CanonicalBase64.decode(hashText, count: 32),
              NaCl.constantTimeEqual(hash, keys.transcriptHash)
        else { throw HandshakeError.invalidAuthenticated("not e2ee_authenticated for this transcript") }
    }

    private static func errorCode(_ object: [String: Any]) -> String {
        ((object["error"] as? [String: Any])?["code"] as? String) ?? "unknown"
    }

    private static func isPayloadKinds(_ value: [Any]) -> Bool {
        (value as? [String]) == HandshakeMessages.payloadKinds
    }

    private static func contextMatches(_ object: [String: Any], _ context: HandshakeContext) -> Bool {
        let expected = context.json
        guard JSONShape.keys(object) == Set(expected.keys) else { return false }
        return expected.allSatisfy { key, value in (object[key] as? String) == (value as? String) }
    }
}
