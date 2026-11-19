import Foundation

/// The facts the leading marker needs (task-read-state.ts).
public struct MarkerFields: Equatable, Sendable {
    public var isRunning: Bool
    /// The session's latest-turn outcome.
    public var status: String
    public var worktreeDeleted: Bool
    /// Read watermark: advances when a run completes.
    public var updatedAt: Date

    public init(isRunning: Bool, status: String, worktreeDeleted: Bool, updatedAt: Date) {
        self.isRunning = isRunning
        self.status = status
        self.worktreeDeleted = worktreeDeleted
        self.updatedAt = updatedAt
    }
}

/// Leading glyph of a session row; `nil` draws the hollow circle.
public enum StatusMarker: Equatable, Sendable {
    case cleaned, completedUnread, failedUnread

    public static func derive(_ fields: MarkerFields, lastViewedAt: Date?) -> StatusMarker? {
        if fields.isRunning { return nil }
        if fields.worktreeDeleted { return .cleaned }
        guard fields.status == "completed" || fields.status == "failed" else { return nil }
        if let lastViewedAt, lastViewedAt >= fields.updatedAt { return nil }
        return fields.status == "failed" ? .failedUnread : .completedUnread
    }

    /// The desktop's labels (en.ts sessionStatus*).
    public var label: String {
        switch self {
        case .cleaned: return "Workspace cleaned up (restored on your next message)"
        case .completedUnread: return "Completed (unread)"
        case .failedUnread: return "Failed (unread)"
        }
    }
}

public struct SublineInput: Equatable, Sendable {
    public var note: String?
    public var summary: String?
    public var forkedFromTitle: String?
    public var delegatedFromTitle: String?

    public init(note: String?, summary: String?, forkedFromTitle: String?, delegatedFromTitle: String?) {
        self.note = note
        self.summary = summary
        self.forkedFromTitle = forkedFromTitle
        self.delegatedFromTitle = delegatedFromTitle
    }
}

/// The one fact a session row shows under its title (session-subline.ts).
public enum Subline: Equatable, Sendable {
    case note(String), summary(String), forked(String), delegated(String), project(String)

    public static func derive(_ input: SublineInput, isRunning: Bool, showProject: Bool, projectName: String?, nestedUnderDelegator: Bool) -> Subline? {
        if isRunning, let note = input.note, !note.isEmpty { return .note(note) }
        if let summary = input.summary, !summary.isEmpty { return .summary(summary) }
        if let note = input.note, !note.isEmpty { return .note(note) }
        if let forked = input.forkedFromTitle, !forked.isEmpty { return .forked(forked) }
        if let delegated = input.delegatedFromTitle, !delegated.isEmpty, !nestedUnderDelegator { return .delegated(delegated) }
        if showProject, let projectName, !projectName.isEmpty { return .project(projectName) }
        return nil
    }

    /// Text as the desktop renders it (en.ts continuedFrom / delegatedFrom).
    public var text: String {
        switch self {
        case .note(let text), .summary(let text), .project(let text): return text
        case .forked(let title): return "Continued from \(title)"
        case .delegated(let title): return "Delegated from \(title)"
        }
    }
}
