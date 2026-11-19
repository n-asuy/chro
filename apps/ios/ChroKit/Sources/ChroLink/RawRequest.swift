import ChroAPI
import Foundation

/// One HTTP call to the desktop's router, carried by the `request` RPC
/// (architecture doc §4.1). Screens use it for `/rpc/*`; `/v1` routes go
/// through `ChroLink.call`, which builds one of these.
public struct RawRequest: Sendable, Equatable {
    public enum Method: String, Sendable, CaseIterable {
        case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE"
    }

    public var method: Method
    /// The URI path as sent: each segment already percent-encoded (see `path(_:)`), no `?` or `#`.
    public var path: String
    public var query: [String: String]
    /// JSON text; sent as the `application/json` body.
    public var body: Data?
    /// Makes a mutating `/v1` call safe to repeat (the server's `idempotency-key`).
    public var requestId: String?

    public init(method: Method = .get, path: String, query: [String: String] = [:], body: Data? = nil, requestId: String? = nil) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.requestId = requestId
    }

    /// `/seg/seg/...` with each raw segment percent-encoded on its own; `:` and
    /// `@` stay literal as the server's router expects.
    public static func path(_ segments: String...) -> String { path(segments) }

    public static func path(_ segments: [String]) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        return segments.map { "/" + ($0.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0) }.joined()
    }

    /// The `request` params `{method, path, query?, body?, requestId?}`.
    func params(upload: (fileName: String, contentType: String)? = nil) throws -> Data {
        var object: [String: Any] = ["method": method.rawValue, "path": path]
        if !query.isEmpty { object["query"] = query }
        if let body {
            guard let value = try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed]) else {
                throw APIError(code: .invalidRequest, message: "The request body is not JSON.")
            }
            object["body"] = value
        }
        if let requestId { object["requestId"] = requestId }
        if let upload {
            object["upload"] = ["field": RawRequest.uploadField, "fileName": upload.fileName, "contentType": upload.contentType]
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    /// The multipart field every image upload route reads.
    static let uploadField = "image"
}

/// The router's answer, in the shape the host chose by `Content-Type`. An HTTP
/// error status is an answer too: it is returned, not thrown.
public enum RawResponse: Sendable, Equatable {
    /// `application/json` (or `+json`); `body` is the JSON text, `null` when the response had no body.
    case json(status: Int, body: Data)
    /// `text/*` up to 4 MiB (plain-text errors, Markdown, HTML).
    case text(status: Int, contentType: String, text: String)
    /// Anything else (images, files), reassembled from binary frames.
    case binary(status: Int, contentType: String, data: Data)

    public var status: Int {
        switch self {
        case .json(let status, _), .text(let status, _, _), .binary(let status, _, _): status
        }
    }

    public var isSuccess: Bool { (200..<300).contains(status) }

    /// A text result: `{status, body}` or `{status, contentType, text}`.
    init(text result: Data) throws {
        guard let object = (try? JSONSerialization.jsonObject(with: result)) as? [String: Any],
              let status = object["status"] as? Int
        else { throw LinkError.malformedResponse("request result is not {status, ...}") }
        if let contentType = object["contentType"] as? String, let text = object["text"] as? String {
            self = .text(status: status, contentType: contentType, text: text)
            return
        }
        guard let body = object["body"] else { throw LinkError.malformedResponse("request result has neither body nor text") }
        self = .json(status: status, body: try JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes]))
    }

    init(_ reply: ChannelReply) throws {
        switch reply {
        case .text(let result): try self.init(text: result)
        case .binary(let binary): self = .binary(status: binary.status, contentType: binary.contentType, data: binary.data)
        }
    }
}

extension ChroLink {
    static let requestMethod = "request"

    /// Sends one router call. Link and RPC failures (timeout, disconnect,
    /// `forbidden`, ...) throw an `APIError`; HTTP statuses are in the response.
    public func send(_ request: RawRequest, timeout: Duration? = nil) async throws -> RawResponse {
        do {
            let reply = try await call(Self.requestMethod, params: try request.params(), timeout: timeout)
            return try RawResponse(reply)
        } catch {
            throw RouteRequest.apiError(error)
        }
    }

    /// Uploads an image as `POST path` with one multipart part named `image`
    /// (`/rpc/images/upload`, `/rpc/tasks/:id/images/upload`, `/rpc/task-runs/:id/images/upload`).
    /// The bytes travel in binary frames; at most 20 MiB.
    public func upload(path: String, fileName: String, contentType: String, data: Data, timeout: Duration? = nil) async throws -> RawResponse {
        do {
            let params = try RawRequest(method: .post, path: path).params(upload: (fileName, contentType))
            return try RawResponse(try await upload(params: params, body: data, timeout: timeout))
        } catch {
            throw RouteRequest.apiError(error)
        }
    }
}
