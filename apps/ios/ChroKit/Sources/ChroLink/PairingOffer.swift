import Foundation

/// Where pairing text came from: the camera only accepts the full `chro://pair`
/// URL, the paste field also accepts the bare code.
public enum PairingCodeSource: Sendable, Equatable {
    case camera
    case paste
}

public enum PairingCodeError: Error, Equatable {
    /// Not a chro pairing code; the UI words it by source (camera vs paste).
    case notAPairingCode(PairingCodeSource)
}

/// The QR payload of `chro://pair?code=<base64url(JSON)>` (offer v2, spec §1.5).
public struct PairingOffer: Equatable, Sendable {
    public static let scheme = "chro"
    public static let maxCodeLength = 128 * 1024
    public static let defaultPort = 6768

    /// `ws://host:port` (or `wss://`), with the default port filled in.
    public let endpoint: URL
    /// The QR ticket; replaced by the phone's own token after the ticket exchange.
    public let deviceToken: String
    /// The host's X25519 public key: the only trust anchor of the pairing.
    public let publicKey: Data
    public let pairedDeviceId: String?
    public let scope: String?

    public var publicKeyB64: String { publicKey.base64EncodedString() }

    public init(endpoint: URL, deviceToken: String, publicKey: Data, pairedDeviceId: String? = nil, scope: String? = nil) {
        self.endpoint = endpoint
        self.deviceToken = deviceToken
        self.publicKey = publicKey
        self.pairedDeviceId = pairedDeviceId
        self.scope = scope
    }

    /// The URL a desktop shows: base64url of the JSON, without padding.
    public var pairingURL: URL {
        var object: [String: Any] = ["v": 2, "endpoint": endpoint.absoluteString, "deviceToken": deviceToken, "publicKeyB64": publicKeyB64]
        if let pairedDeviceId { object["pairedDeviceId"] = pairedDeviceId }
        if let scope { object["scope"] = scope }
        let json = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        let code = json.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return URL(string: "\(Self.scheme)://pair?code=\(code)")!
    }

    /// Decodes scanned or pasted text. Accepts standard base64 and base64url,
    /// with or without padding, any JSON key order, and ignores unknown keys.
    public static func decode(_ text: String, source: PairingCodeSource) throws -> PairingOffer {
        let rejected = PairingCodeError.notAPairingCode(source)
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let code: String
        if let fromURL = try codeFromURL(trimmed, rejected: rejected) {
            code = fromURL
        } else if source == .paste {
            code = trimmed
        } else {
            throw rejected
        }
        guard let json = decodeCode(code) else { throw rejected }
        guard let offer = parse(json) else { throw rejected }
        return offer
    }

    /// The code of a `chro://pair` URL; nil when the text is not a chro URL at all.
    private static func codeFromURL(_ text: String, rejected: PairingCodeError) throws -> String? {
        let prefix = "\(scheme)://"
        guard text.count >= prefix.count, text.prefix(prefix.count).lowercased() == prefix else { return nil }
        let rest = text.dropFirst(prefix.count)
        let authorityEnd = rest.firstIndex { $0 == "/" || $0 == "?" || $0 == "#" } ?? rest.endIndex
        guard rest[..<authorityEnd].lowercased() == "pair" else { throw rejected }
        let afterAuthority = rest[authorityEnd...]
        let pathEnd = afterAuthority.firstIndex { $0 == "?" || $0 == "#" } ?? afterAuthority.endIndex
        let path = afterAuthority[..<pathEnd]
        guard path.isEmpty || path == "/" else { throw rejected }
        let tail = afterAuthority[pathEnd...]
        var query = Substring("")
        var fragment: Substring?
        if tail.first == "?" {
            let body = tail.dropFirst()
            if let hash = body.firstIndex(of: "#") {
                query = body[..<hash]
                fragment = body[body.index(after: hash)...]
            } else {
                query = body
            }
        } else if tail.first == "#" {
            fragment = tail.dropFirst()
        }
        for pair in query.split(separator: "&", omittingEmptySubsequences: true) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.first == "code" else { continue }
            // `+` stays `+`: it is a base64 symbol here, not a form-encoded space.
            let raw = parts.count > 1 ? String(parts[1]) : ""
            guard let value = raw.removingPercentEncoding, !value.isEmpty else { throw rejected }
            return value
        }
        if let fragment, !fragment.isEmpty {
            guard let value = String(fragment).removingPercentEncoding else { throw rejected }
            return value
        }
        throw rejected
    }

    private static func decodeCode(_ code: String) -> Data? {
        guard (1...maxCodeLength).contains(code.utf8.count) else { return nil }
        let bytes = Array(code.utf8)
        let symbols = bytes.prefix { $0 != UInt8(ascii: "=") }
        let padding = bytes.count - symbols.count
        guard !symbols.isEmpty, padding <= 2, bytes[symbols.count...].allSatisfy({ $0 == UInt8(ascii: "=") }) else { return nil }
        guard symbols.allSatisfy(isCodeSymbol) else { return nil }
        guard symbols.count % 4 != 1 else { return nil }
        var normalized = String(decoding: symbols, as: UTF8.self)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        normalized += String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        return Data(base64Encoded: normalized)
    }

    private static func isCodeSymbol(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "0")...UInt8(ascii: "9"):
            true
        case UInt8(ascii: "+"), UInt8(ascii: "/"), UInt8(ascii: "-"), UInt8(ascii: "_"):
            true
        default:
            false
        }
    }

    private static func parse(_ json: Data) -> PairingOffer? {
        guard let object = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any] else { return nil }
        guard JSONShape.isInteger(object["v"], equalTo: 2) else { return nil }
        guard let endpointText = object["endpoint"] as? String, (1...16384).contains(endpointText.count),
              let endpoint = normalizedEndpoint(endpointText) else { return nil }
        guard let deviceToken = object["deviceToken"] as? String, (1...65536).contains(deviceToken.count) else { return nil }
        guard let keyText = object["publicKeyB64"] as? String,
              let publicKey = try? CanonicalBase64.decode(keyText, count: NaCl.keyBytes) else { return nil }
        var pairedDeviceId: String?
        if let value = object["pairedDeviceId"] {
            guard let text = value as? String, (1...128).contains(text.count) else { return nil }
            pairedDeviceId = text
        }
        var scope: String?
        if let value = object["scope"] {
            guard let text = value as? String, text == "mobile" || text == "runtime" else { return nil }
            scope = text
        }
        // A relay section is never valid on a runtime-scoped offer. This version
        // connects directly and does not read the relay section otherwise.
        if scope == "runtime", object["relay"] != nil { return nil }
        return PairingOffer(endpoint: endpoint, deviceToken: deviceToken, publicKey: publicKey, pairedDeviceId: pairedDeviceId, scope: scope)
    }

    /// `ws://host[:port]` or `wss://host[:port]` with no user info, path, query or
    /// fragment; a missing port becomes 6768 (ws) or 443 (wss).
    static func normalizedEndpoint(_ text: String) -> URL? {
        guard var components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(), scheme == "ws" || scheme == "wss",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.path.isEmpty || components.path == "/",
              components.query == nil, components.fragment == nil
        else { return nil }
        components.scheme = scheme
        components.path = ""
        if components.port == nil { components.port = scheme == "ws" ? defaultPort : 443 }
        guard let port = components.port, port > 0 else { return nil }
        return components.url
    }
}

/// Small checks on JSONSerialization output.
enum JSONShape {
    /// True for a JSON integer (not a bool, not a fraction) of the given value.
    static func isInteger(_ value: Any?, equalTo expected: Int) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        return number.doubleValue == Double(expected)
    }

    static func isString(_ value: Any?, equalTo expected: String) -> Bool {
        (value as? String) == expected
    }

    static func keys(_ object: [String: Any]) -> Set<String> { Set(object.keys) }
}
