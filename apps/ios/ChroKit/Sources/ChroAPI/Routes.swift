import Foundation

public enum HTTPMethod: String, Sendable { case get = "GET", post = "POST", patch = "PATCH", delete = "DELETE" }

/// One operator endpoint with its request and result types (routes.rs).
public struct Route<Request: Encodable & Sendable, Result: Decodable & Sendable>: Sendable {
    public let method: HTTPMethod
    /// Path segments; each is percent-encoded on its own when the URL is built.
    public let segments: [String]
    public var isMutating: Bool { method != .get }
}

public enum Routes {
    public static let status = Route<NoBody, StatusView>(method: .get, segments: ["v1", "status"])
    public static let projects = Route<NoBody, ProjectList>(method: .get, segments: ["v1", "projects"])
    public static let sessions = Route<NoBody, SessionList>(method: .get, segments: ["v1", "sessions"])
    public static let sessionCreate = Route<NewSession, SessionStarted>(method: .post, segments: ["v1", "sessions"])
    public static func session(session: String) -> Route<NoBody, SessionView> { .init(method: .get, segments: ["v1", "sessions", session]) }
    public static func sessionUpdate(session: String) -> Route<UpdateSession, SessionView> { .init(method: .patch, segments: ["v1", "sessions", session]) }
    public static func sessionFork(session: String) -> Route<Fork, Forked> { .init(method: .post, segments: ["v1", "sessions", session, "forks"]) }
    public static func sessionSend(session: String) -> Route<SendMessage, MessageAccepted> { .init(method: .post, segments: ["v1", "sessions", session, "messages"]) }
    public static func sessionEntries(session: String) -> Route<NoBody, Entries> { .init(method: .get, segments: ["v1", "sessions", session, "entries"]) }
    public static func sessionCancel(session: String) -> Route<NoBody, SessionView> { .init(method: .post, segments: ["v1", "sessions", session, "cancel"]) }
    public static func sessionUnqueue(session: String, message: String) -> Route<NoBody, SessionView> { .init(method: .delete, segments: ["v1", "sessions", session, "queue", message]) }
    public static func sessionRefs(session: String) -> Route<NoBody, Refs> { .init(method: .get, segments: ["v1", "sessions", session, "refs"]) }
    public static func sessionDiff(session: String) -> Route<NoBody, DiffView> { .init(method: .get, segments: ["v1", "sessions", session, "diff"]) }
    public static func sessionMerge(session: String) -> Route<Merge, Merged> { .init(method: .post, segments: ["v1", "sessions", session, "merge"]) }
    public static func sessionRebase(session: String) -> Route<Rebase, Rebased> { .init(method: .post, segments: ["v1", "sessions", session, "rebase"]) }
    public static let approvals = Route<NoBody, ApprovalList>(method: .get, segments: ["v1", "approvals"])
    public static func approvalRespond(approval: String) -> Route<Respond, Responded> { .init(method: .post, segments: ["v1", "approvals", approval, "respond"]) }
}

public struct CallerView: Codable, Equatable, Sendable {
    /// `user` or `agent`.
    public let kind: String
    public let session: SessionRef?
}

public struct StatusView: Codable, Equatable, Sendable {
    public let version: String
    public let contractRev: String
    public let runtimeId: String
    public let pid: UInt32
    public let url: String
    public let caller: CallerView
}
