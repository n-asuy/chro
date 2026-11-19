import Foundation

/// The coding agent a session runs on (`ExecutorKind` on the server).
public enum AgentKind: String, Sendable, Codable, CaseIterable, Hashable {
    case claudeCode = "CLAUDE_CODE"
    case codex = "CODEX"
    case pi = "PI"

    public var displayName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .codex: return "Codex"
        case .pi: return "pi"
        }
    }
}

/// A project as the left panel and the project switcher know it.
public struct ProjectSummary: Identifiable, Equatable, Sendable, Hashable {
    public var id: String
    public var name: String
    public var path: String
    public var isGitRepository: Bool
    /// A preset name (`red`, `blue`, ...) or a `#rrggbb` hex; nil draws no badge.
    public var badgeColor: String?

    public init(id: String, name: String, path: String, isGitRepository: Bool = true, badgeColor: String? = nil) {
        self.id = id
        self.name = name
        self.path = path
        self.isGitRepository = isGitRepository
        self.badgeColor = badgeColor
    }
}

/// The facts of one session (a task row on the server) that the session list,
/// the palette and the project overview need.
public struct SessionSummary: Identifiable, Equatable, Sendable, Hashable {
    public var id: String
    /// The short id the desktop shows in monospace (first 4 hex of the task id).
    public var shortID: String
    public var projectID: String
    public var title: String?
    /// The latest turn's outcome: `pending`, `in_progress`, `completed`, `failed` or `cancelled`.
    public var status: String
    /// A run is attached (`active_session_id`).
    public var isRunning: Bool
    /// The agent is blocked on the user (an approval or a question).
    public var awaitingInput: Bool
    public var worktreeDeleted: Bool
    public var delegatedFromID: String?
    public var forkedFromTitle: String?
    public var note: String?
    public var summary: String?
    public var agent: AgentKind
    public var model: String?
    public var branch: String?
    public var targetBranch: String?
    public var createdAt: Date
    /// Also the read watermark: advances when a run completes.
    public var updatedAt: Date

    public init(id: String, shortID: String, projectID: String, title: String?, status: String, isRunning: Bool = false,
                awaitingInput: Bool = false, worktreeDeleted: Bool = false, delegatedFromID: String? = nil,
                forkedFromTitle: String? = nil, note: String? = nil, summary: String? = nil, agent: AgentKind,
                model: String? = nil, branch: String? = nil, targetBranch: String? = nil, createdAt: Date? = nil, updatedAt: Date) {
        self.id = id
        self.shortID = shortID
        self.projectID = projectID
        self.title = title
        self.status = status
        self.isRunning = isRunning
        self.awaitingInput = awaitingInput
        self.worktreeDeleted = worktreeDeleted
        self.delegatedFromID = delegatedFromID
        self.forkedFromTitle = forkedFromTitle
        self.note = note
        self.summary = summary
        self.agent = agent
        self.model = model
        self.branch = branch
        self.targetBranch = targetBranch
        self.createdAt = createdAt ?? updatedAt
        self.updatedAt = updatedAt
    }

    /// The desktop's fallback for a session the agent has not titled yet (en.ts unconfirmedSession).
    public static let untitledLabel = "Unconfirmed Session"

    public var hasTitle: Bool { !(title ?? "").isEmpty }
    public var displayTitle: String { hasTitle ? title! : Self.untitledLabel }

    public var markerFields: MarkerFields {
        MarkerFields(isRunning: isRunning, status: status, worktreeDeleted: worktreeDeleted, updatedAt: updatedAt)
    }

    public func marker(lastViewedAt: Date?) -> StatusMarker? {
        StatusMarker.derive(markerFields, lastViewedAt: lastViewedAt)
    }
}
