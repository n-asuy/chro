import Foundation

/// `error` of an `ok:false` RPC response.
public struct RPCError: Error, Equatable, Sendable {
    public let code: String
    public let message: String
    /// `error.data` as JSON text, when present and not null.
    public let data: Data?

    public init(code: String, message: String, data: Data? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }

    public static let unauthorizedCode = "unauthorized"
    public static let incompatibleAPICode = "incompatible_api"
}

/// Failures of link calls that are not the server's answer.
public enum LinkError: Error, Equatable, Sendable {
    /// No response within the request's timeout (30 s by default).
    case timeout
    /// The connection ended before the response arrived.
    case disconnected
    /// Three rejections in a row; the pairing may be revoked.
    case authFailed
    /// The server's `apiGeneration` differs from this app's.
    case incompatibleAPI
    /// `stop()` was called.
    case stopped
    /// The server answered `ok:false`.
    case rpc(RPCError)
    /// The request exceeds what the host accepts (a 1 MiB message, a 20 MiB upload); nothing was sent.
    case requestTooLarge
    /// The response was not the documented shape.
    case malformedResponse(String)
}

extension LinkError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .timeout: "The desktop did not answer in time."
        case .disconnected: "Disconnected from the desktop."
        case .authFailed: "Unauthorized: the pairing may have been revoked."
        case .incompatibleAPI: "This app and the desktop's chro are not compatible. Update both."
        case .stopped: "The connection was closed."
        case .rpc(let error): error.message
        case .requestTooLarge: "The request is too large to send to the desktop."
        case .malformedResponse(let detail): "Unexpected response from the desktop (\(detail))."
        }
    }
}

/// JSON text of the RPC envelopes inside encrypted text frames (spec §4.2).
enum RPCWire {
    /// `{id, deviceToken, method, params}` in that key order; `params` is embedded as given.
    static func request(id: String, deviceToken: String, method: String, params: Data) -> Data {
        var out = Data("{\"id\":\(HandshakeMessages.quote(id)),\"deviceToken\":\(HandshakeMessages.quote(deviceToken)),\"method\":\(HandshakeMessages.quote(method)),\"params\":".utf8)
        out.append(params)
        out.append(Data("}".utf8))
        return out
    }

    struct Response {
        let id: String
        let streaming: Bool
        let outcome: Result<Data, RPCError>
    }

    /// Parses `{id, ok, result|error, _meta, streaming?}`; `result` comes back as JSON text.
    static func response(_ payload: Data) throws -> Response {
        guard let object = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] else {
            throw LinkError.malformedResponse("not a JSON object")
        }
        guard let id = object["id"] as? String, !id.isEmpty else { throw LinkError.malformedResponse("id") }
        guard let ok = object["ok"] as? Bool else { throw LinkError.malformedResponse("ok") }
        let streaming = (object["streaming"] as? Bool) ?? false
        if ok {
            let result = object["result"] ?? NSNull()
            let data = try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])
            return Response(id: id, streaming: streaming, outcome: .success(data))
        }
        guard let error = object["error"] as? [String: Any], let code = error["code"] as? String else {
            throw LinkError.malformedResponse("error")
        }
        var detail: Data?
        if let value = error["data"], !(value is NSNull) {
            detail = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        }
        return Response(id: id, streaming: streaming, outcome: .failure(RPCError(code: code, message: (error["message"] as? String) ?? "", data: detail)))
    }
}

/// JSON encoding of RPC params and decoding of results (camelCase keys, as the envelope uses).
enum RPCCoding {
    static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw LinkError.malformedResponse("\(T.self): \(error)")
        }
    }
}
