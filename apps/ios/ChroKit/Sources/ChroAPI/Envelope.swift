import Foundation

/// `{ ok, result | error, meta }` wrapping every operator API response (envelope.rs).
public struct Envelope<T: Decodable>: Decodable {
    public let ok: Bool
    public let value: T?
    public let error: APIError?
    public let meta: Meta

    enum CodingKeys: String, CodingKey { case ok, result, error, meta }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decode(Bool.self, forKey: .ok)
        value = try container.decodeIfPresent(T.self, forKey: .result)
        error = try container.decodeIfPresent(APIError.self, forKey: .error)
        meta = try container.decode(Meta.self, forKey: .meta)
    }

    public func result() throws -> T {
        if ok, let value { return value }
        if !ok, let error { throw error }
        throw APIError(code: .internal, message: "response is neither a result nor an error")
    }
}

public struct Meta: Decodable, Equatable, Sendable {
    public let runtimeId: String?
    public let contractRev: String
}

/// The closed failure set of error.rs; unknown codes decode as `.unknown`.
public struct ErrorCode: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let usage = ErrorCode(rawValue: "usage")
    public static let invalidRequest = ErrorCode(rawValue: "invalid_request")
    public static let invalidSelector = ErrorCode(rawValue: "invalid_selector")
    public static let notFound = ErrorCode(rawValue: "not_found")
    public static let ambiguous = ErrorCode(rawValue: "ambiguous")
    public static let sessionBusy = ErrorCode(rawValue: "session_busy")
    public static let gitConflict = ErrorCode(rawValue: "git_conflict")
    public static let selfResponseForbidden = ErrorCode(rawValue: "self_response_forbidden")
    public static let approvalClosed = ErrorCode(rawValue: "approval_closed")
    public static let requestInProgress = ErrorCode(rawValue: "request_in_progress")
    public static let runtimeNotRunning = ErrorCode(rawValue: "runtime_not_running")
    public static let runtimeStale = ErrorCode(rawValue: "runtime_stale")
    public static let unreachable = ErrorCode(rawValue: "unreachable")
    public static let timeout = ErrorCode(rawValue: "timeout")
    public static let unauthorized = ErrorCode(rawValue: "unauthorized")
    public static let contractMismatch = ErrorCode(rawValue: "contract_mismatch")
    public static let `internal` = ErrorCode(rawValue: "internal")
    public static func unknown(_ raw: String) -> ErrorCode { ErrorCode(rawValue: raw) }

    static let known: Set<String> = [
        "usage", "invalid_request", "invalid_selector", "not_found", "ambiguous", "session_busy", "git_conflict",
        "self_response_forbidden", "approval_closed", "request_in_progress", "runtime_not_running", "runtime_stale",
        "unreachable", "timeout", "unauthorized", "contract_mismatch", "internal",
    ]
    public var isKnown: Bool { Self.known.contains(rawValue) }
}

/// ErrorBody of error.rs, thrown by calls that fail.
public struct APIError: Error, Decodable, Equatable, Sendable {
    public let code: ErrorCode
    public let message: String
    public let next: [String]
    public let candidates: [String]

    public init(code: ErrorCode, message: String, next: [String] = [], candidates: [String] = []) {
        self.code = code
        self.message = message
        self.next = next
        self.candidates = candidates
    }

    enum CodingKeys: String, CodingKey { case code, message, next, candidates }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        code = try container.decode(ErrorCode.self, forKey: .code)
        message = try container.decode(String.self, forKey: .message)
        next = try container.decodeIfPresent([String].self, forKey: .next) ?? []
        candidates = try container.decodeIfPresent([String].self, forKey: .candidates) ?? []
    }
}
