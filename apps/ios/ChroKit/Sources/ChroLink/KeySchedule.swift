import CryptoKit
import Foundation

/// chro's domain-separation strings of E2EE v2 (architecture doc §3).
public enum E2EELabels {
    public static let protocolName = "chro-mobile-e2ee"
    public static let transcriptDomain = Data("chro-mobile-e2ee/v2/transcript".utf8)
    public static let salt = Data("chro-mobile-e2ee/v2/salt\0".utf8)
    public static let session = Data("chro-mobile-e2ee/v2/session\0".utf8)
}

/// The `context` object both handshake messages carry.
public enum HandshakeContext: Equatable, Sendable {
    case direct
    case relay(hostId: String)

    static let initiator = "mobile"
    static let responder = "desktop"

    var transport: String {
        switch self {
        case .direct: "direct"
        case .relay: "relay"
        }
    }

    var relayHostId: String? {
        if case .relay(let hostId) = self { return hostId }
        return nil
    }

    /// The JSON object, with `relayHostId` only for the relay transport.
    var json: [String: Any] {
        var object: [String: Any] = [
            "protocol": E2EELabels.protocolName,
            "initiator": Self.initiator,
            "responder": Self.responder,
            "transport": transport,
        ]
        if let relayHostId { object["relayHostId"] = relayHostId }
        return object
    }
}

/// Length-prefixed transcript of the hello/ready pair (spec §3.3). Keys and
/// nonces enter as their raw 32 bytes, not as base64.
public enum Transcript {
    public static func encode(context: HandshakeContext, clientPublicKey: Data, clientNonce: Data, desktopPublicKey: Data, desktopNonce: Data) -> Data {
        var out = Data()
        func field(_ name: String, _ value: Data) {
            out.append(u32(name.utf8.count))
            out.append(Data(name.utf8))
            out.append(u32(value.count))
            out.append(value)
        }
        func text(_ value: String) -> Data { Data(value.utf8) }
        func numbers(_ values: [UInt32]) -> Data {
            var data = u32(values.count)
            for value in values { data.append(u32(Int(value))) }
            return data
        }
        func strings(_ values: [String]) -> Data {
            var data = u32(values.count)
            for value in values {
                data.append(u32(value.utf8.count))
                data.append(Data(value.utf8))
            }
            return data
        }
        func contextFields(_ prefix: String) {
            field("\(prefix).context.protocol", text(E2EELabels.protocolName))
            field("\(prefix).context.initiator", text(HandshakeContext.initiator))
            field("\(prefix).context.responder", text(HandshakeContext.responder))
            field("\(prefix).context.transport", text(context.transport))
            field("\(prefix).context.relay-host-id", text(context.relayHostId ?? ""))
        }

        field("domain", E2EELabels.transcriptDomain)
        field("mobile-to-desktop.type", text(HandshakeMessages.helloType))
        field("mobile-to-desktop.version", u32(HandshakeMessages.version))
        field("mobile-to-desktop.client-public-key", clientPublicKey)
        field("mobile-to-desktop.client-nonce", clientNonce)
        field("mobile-to-desktop.capabilities.framing", numbers([UInt32(HandshakeMessages.framing)]))
        field("mobile-to-desktop.capabilities.payload-kinds", strings(HandshakeMessages.payloadKinds))
        contextFields("mobile-to-desktop")
        field("desktop-to-mobile.type", text(HandshakeMessages.readyType))
        field("desktop-to-mobile.version", u32(HandshakeMessages.version))
        field("desktop-to-mobile.desktop-public-key", desktopPublicKey)
        field("desktop-to-mobile.client-nonce-echo", clientNonce)
        field("desktop-to-mobile.desktop-nonce", desktopNonce)
        field("desktop-to-mobile.selection.framing", u32(HandshakeMessages.framing))
        field("desktop-to-mobile.selection.payload-kinds", strings(HandshakeMessages.payloadKinds))
        contextFields("desktop-to-mobile")
        return out
    }

    private static func u32(_ value: Int) -> Data {
        withUnsafeBytes(of: UInt32(value).bigEndian) { Data($0) }
    }
}

/// The per-connection keys of one E2EE v2 session.
public struct SessionKeys: Equatable, Sendable {
    public let mobileToDesktopKey: Data
    public let desktopToMobileKey: Data
    public let sessionId: Data
    public let transcriptHash: Data

    public init(mobileToDesktopKey: Data, desktopToMobileKey: Data, sessionId: Data, transcriptHash: Data) {
        self.mobileToDesktopKey = mobileToDesktopKey
        self.desktopToMobileKey = desktopToMobileKey
        self.sessionId = sessionId
        self.transcriptHash = transcriptHash
    }

    func key(for direction: FrameDirection) -> Data {
        direction == .mobileToDesktop ? mobileToDesktopKey : desktopToMobileKey
    }
}

/// HKDF-SHA256 over the `crypto_box_beforenm` output (spec §3.4).
public enum KeySchedule {
    public static func derive(shared: Data, clientNonce: Data, desktopNonce: Data, transcript: Data) -> SessionKeys {
        let transcriptHash = Data(SHA256.hash(data: transcript))
        let salt = Data(SHA256.hash(data: E2EELabels.salt + clientNonce + desktopNonce))
        let info = E2EELabels.session + transcriptHash
        let okm = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: shared), salt: salt, info: info, outputByteCount: 96)
            .withUnsafeBytes { Data($0) }
        return SessionKeys(
            mobileToDesktopKey: okm.subdata(in: 0..<32),
            desktopToMobileKey: okm.subdata(in: 32..<64),
            sessionId: okm.subdata(in: 64..<96),
            transcriptHash: transcriptHash
        )
    }
}
