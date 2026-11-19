import ChroAPI
import Foundation

/// Operator API (`/v1`) routes over the link: a `RawRequest` whose JSON answer
/// is the route's usual envelope `{ok, result|error, meta}`.
enum RouteRequest {
    static func path<Req, Res>(_ route: Route<Req, Res>) -> String {
        RawRequest.path(route.segments)
    }

    /// Mutating calls carry `requestId` and a snake_case body (`{}` when there is none).
    static func raw<Req, Res>(_ route: Route<Req, Res>, query: [String: String], body: Req?, requestId: String) throws -> RawRequest {
        let method = RawRequest.Method(rawValue: route.method.rawValue)!
        guard route.isMutating else { return RawRequest(method: method, path: path(route), query: query) }
        let json: Data
        if let body, !(body is NoBody) {
            json = try APIEncoder.make().encode(body)
        } else {
            json = Data("{}".utf8)
        }
        return RawRequest(method: method, path: path(route), query: query, body: json, requestId: requestId)
    }

    /// Unwraps the envelope into the route's result or its `APIError`.
    static func result<Res: Decodable>(_ type: Res.Type, from response: RawResponse) throws -> Res {
        switch response {
        case .json(let status, let body):
            guard let envelope = try? APIDecoder.make().decode(Envelope<Res>.self, from: body) else {
                throw APIError(code: .internal, message: "HTTP \(status) without an envelope")
            }
            return try envelope.result()
        case .text(let status, _, let text):
            throw APIError(code: .internal, message: "HTTP \(status): \(text)")
        case .binary(let status, let contentType, _):
            throw APIError(code: .internal, message: "HTTP \(status) answered \(contentType) instead of an envelope")
        }
    }

    /// The `APIError` a screen shows for a link failure.
    static func apiError(_ error: Error) -> APIError {
        if let error = error as? APIError { return error }
        guard let error = error as? LinkError else {
            return APIError(code: .internal, message: error.localizedDescription)
        }
        let message = error.errorDescription ?? "\(error)"
        switch error {
        case .timeout: return APIError(code: .timeout, message: message)
        case .disconnected, .stopped: return APIError(code: .unreachable, message: message)
        case .authFailed: return APIError(code: .unauthorized, message: message)
        case .incompatibleAPI: return APIError(code: .contractMismatch, message: message)
        case .rpc(let rpc): return APIError(code: ErrorCode(rawValue: rpc.code), message: rpc.message)
        case .requestTooLarge: return APIError(code: .invalidRequest, message: message)
        case .malformedResponse: return APIError(code: .internal, message: message)
        }
    }
}

extension ChroLink {
    /// Calls one operator API route. A mutating call is safe to repeat with the
    /// same `requestId`: the server deduplicates it. Every failure is an `APIError`.
    public func call<Req, Res>(
        _ route: Route<Req, Res>,
        query: [String: String] = [:],
        body: Req? = nil,
        requestId: String = UUID().uuidString,
        timeout: Duration? = nil
    ) async throws -> Res {
        let request: RawRequest
        do {
            request = try RouteRequest.raw(route, query: query, body: body, requestId: requestId)
        } catch {
            throw RouteRequest.apiError(error)
        }
        return try RouteRequest.result(Res.self, from: try await send(request, timeout: timeout))
    }
}
