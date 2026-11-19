import ChroDomain
import Foundation

/// A session in a project's Archive sheet.
public struct ArchivedSession: Identifiable, Equatable, Sendable {
    public var session: SessionSummary
    public var archivedAt: Date
    public var id: String { session.id }

    public init(session: SessionSummary, archivedAt: Date) {
        self.session = session
        self.archivedAt = archivedAt
    }
}

/// A page of a project's archive and how many archived sessions match in all.
public struct ArchivedPage: Equatable, Sendable {
    public var sessions: [ArchivedSession]
    public var total: Int

    public init(sessions: [ArchivedSession], total: Int) {
        self.sessions = sessions
        self.total = total
    }

    /// Rows one page holds.
    public static let size = 50
}

/// A context reference the composer attaches to a prompt (`@file`, `#skill`, `@session`, a photo).
public struct ComposerReference: Equatable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable, Hashable { case file, directory, skill, session, image }
    public var kind: Kind
    /// What the pill shows, e.g. `@stock.ts` or `#chro`.
    public var label: String
    /// The path, skill name or session id the pill stands for.
    public var target: String
    /// Image bytes for `.image`; uploaded by the live implementation before the session starts.
    public var imageData: Data?
    public var id: String { "\(kind.rawValue):\(target)" }

    public init(kind: Kind, label: String, target: String, imageData: Data? = nil) {
        self.kind = kind
        self.label = label
        self.target = target
        self.imageData = imageData
    }
}

/// POST /v1/sessions as the composer of Home and New session builds it.
public struct NewSessionRequest: Equatable, Sendable {
    public var projectID: String
    public var prompt: String
    public var runtime: RuntimeChoice
    /// "From": the branch the worktree starts from; nil in a scratch chat.
    public var baseBranch: String?
    /// Worktree or Local checkout; always false in a scratch chat.
    public var useWorktree: Bool
    public var references: [ComposerReference]

    public init(projectID: String, prompt: String, runtime: RuntimeChoice, baseBranch: String?, useWorktree: Bool, references: [ComposerReference] = []) {
        self.projectID = projectID
        self.prompt = prompt
        self.runtime = runtime
        self.baseBranch = baseBranch
        self.useWorktree = useWorktree
        self.references = references
    }
}

public enum ServiceError: Error, Equatable, Sendable {
    case notFound(String)
    case invalid(String)
    case unavailable(String)
    /// The server refused; the message is the desktop's toast title.
    case refused(String)
    /// A change whose answer was lost (the desktop's `deadline_exceeded`, a dropped
    /// connection, no answer in time): it may or may not have taken effect, so the
    /// screen reads the state again.
    case outcomeUnknown(String)

    public var message: String {
        switch self {
        case .notFound(let what): return "\(what) was not found."
        case .invalid(let why), .unavailable(let why), .refused(let why), .outcomeUnknown(let why): return why
        }
    }

    public var isOutcomeUnknown: Bool { if case .outcomeUnknown = self { true } else { false } }
}

/// The sessions of the paired desktop: the list stream (non-archived, most
/// recent first, kept current), the archive, and starting a session.
public protocol SessionsService: Sendable {
    /// The sessions the phone holds: a window of the host's live sessions
    /// (architecture doc §27), or all of them on a host without one.
    func sessions() -> AsyncStream<[SessionSummary]>
    /// Live and archived sessions per project on the host, held or not.
    func sessionCounts() -> AsyncStream<[String: SessionCounts]>
    /// "Show more": hold the next page of a project's list.
    func showMoreSessions(projectID: String) async throws
    /// Live sessions of any project whose title or project name contains `query`, newest first.
    func searchSessions(matching query: String) async throws -> [SessionSummary]
    /// Hold a session found by search (or named elsewhere) so it stays current.
    func holdSession(sessionID: String) async
    /// A page of the project's archive whose titles contain `query`, newest first.
    func archivedSessions(projectID: String, matching query: String, offset: Int) async throws -> ArchivedPage
    func archive(sessionID: String) async throws
    func restore(sessionID: String) async throws
    func startSession(_ request: NewSessionRequest) async throws -> SessionSummary
    /// "Continue in new session" / "Continue in new worktree": fork the
    /// conversation into a new idle session. A running session cannot be forked.
    func continueSession(sessionID: String, in checkout: ContinuationCheckout) async throws -> SessionSummary
}

/// Where a continued session works: the source's checkout or a new worktree.
public enum ContinuationCheckout: String, Sendable, Equatable {
    case sameCheckout = "same"
    case newWorktree = "new_worktree"
}
