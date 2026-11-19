import Foundation

/// The round buttons at the composer's right (session-input-controls.tsx).
public enum SendControls: Equatable, Sendable {
    /// Idle: the solid Send, disabled while the prompt is empty or images upload.
    case send(enabled: Bool)
    /// A turn runs: the soft Stop, with Add to queue beside it once there is a prompt.
    case running(canQueue: Bool)
    /// Stop was pressed: the disabled spinner.
    case stopping

    public static func resolve(isRunning: Bool, isStopping: Bool, isEmpty: Bool, isUploading: Bool) -> SendControls {
        if isStopping { return .stopping }
        if isRunning { return .running(canQueue: !isEmpty && !isUploading) }
        return .send(enabled: !isEmpty && !isUploading)
    }
}

/// executor-setting-locks.ts: the runtime is tied to the session once it has
/// run; the model is a per-turn override, locked only while a turn runs.
public struct ExecutorLocks: Equatable, Sendable {
    public var runtimeLocked: Bool
    public var modelLocked: Bool

    public init(runtimeLocked: Bool, modelLocked: Bool) {
        self.runtimeLocked = runtimeLocked
        self.modelLocked = modelLocked
    }

    public init(hasRun: Bool, isRunning: Bool) {
        self.init(runtimeLocked: hasRun || isRunning, modelLocked: isRunning)
    }

    /// The model pill is disabled when nothing in it can change.
    public var pickerDisabled: Bool { runtimeLocked && modelLocked }

    /// The tooltip of a model row that belongs to another runtime.
    public static let otherRuntimeHint = "Start a new session to switch runtime"
}

/// How a referenced session relates to this one (session-references-popover.tsx).
public enum SessionRelation: String, Equatable, Sendable, Hashable, CaseIterable {
    case delegatedTo = "delegated_to"
    case delegatedFrom = "delegated_from"
    case continuedFrom = "continued_from"
    case continuedIn = "continued_in"
    case uses
    case referencedBy = "referenced_by"

    public var label: String {
        switch self {
        case .delegatedTo: return "Delegated to"
        case .delegatedFrom: return "Delegated from"
        case .continuedFrom: return "Continued from"
        case .continuedIn: return "Continued in"
        case .uses: return "Uses"
        case .referencedBy: return "Referenced by"
        }
    }
}

/// What follows a session reference's relation label.
public enum ReferenceRunState: Equatable, Sendable {
    case running(awaitingInput: Bool)
    case done
    case failed
    case none

    public static func derive(isRunning: Bool, awaitingInput: Bool, status: String) -> ReferenceRunState {
        if isRunning { return .running(awaitingInput: awaitingInput) }
        switch status {
        case "completed": return .done
        case "failed": return .failed
        default: return .none
        }
    }

    /// " · Done" / " · Failed"; the running state draws the activity glyph instead.
    public var suffix: String? {
        switch self {
        case .done: return " · Done"
        case .failed: return " · Failed"
        case .running, .none: return nil
        }
    }
}

/// lib/git-error.ts: a failed git operation as a sentence the user can act on.
public enum GitErrorText {
    private static let pushRejectHints = ["fetch first", "non-fast-forward", "remote contains work", "failed to push some refs", "rejected"]

    /// First match wins; "nothing to merge" is read before the broad conflict check.
    private static let rules: [([String], String)] = [
        (["authentication failed", "could not read username"], "Authentication failed. Check your credentials."),
        (["permission denied", "publickey"], "Permission denied. Check your SSH key or access."),
        (["repository not found"], "Repository not found. Check the remote URL."),
        (["could not read from remote repository", "no such remote"], "Unable to access the remote repository."),
        (["no upstream", "set upstream", "@{u}"], "No upstream branch set. Publish or set upstream."),
        (["nothing to merge"], "Already up to date. This branch has no changes left to merge."),
        (["no commits of its own yet"], "This session continues an earlier one and has no commits of its own yet. Rebasing now would only drop the point it continues from. Commit its work first, or start a new session on the base branch."),
        (["merge conflict", "rebase conflict", "conflict"], "Merge conflict detected. Resolve conflicts and retry."),
        (["rebase in progress"], "Rebase in progress. Resolve or abort before retrying."),
        (["not a git repository"], "This folder is not a Git repository."),
        (["could not resolve host", "failed to connect", "connection timed out", "unable to access"], "Network error. Check your connection."),
        (["local changes would be overwritten"], "Local changes would be overwritten. Commit or stash first."),
    ]

    public static func resolve(_ message: String, fallback: String) -> String {
        let normalized = message.replacingOccurrences(of: #"^bad request:\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = normalized.lowercased()
        if lower.contains("git push") && pushRejectHints.contains(where: lower.contains) {
            return "Remote has new changes. Pull before pushing."
        }
        if let rule = rules.first(where: { $0.0.contains(where: lower.contains) }) { return rule.1 }
        return normalized.isEmpty ? fallback : "Git error: \(normalized)"
    }
}

/// The git operation a conflict stopped (use-branch-status.ts ConflictOp).
public enum ConflictOperation: String, Equatable, Sendable, Hashable {
    case rebase, merge
    case cherryPick = "cherry_pick"
    case revert

    public var title: String {
        switch self {
        case .rebase: return "Rebase"
        case .merge: return "Merge"
        case .cherryPick: return "Cherry-pick"
        case .revert: return "Revert"
        }
    }
}

/// The banner above the composer while a rebase or merge stopped on conflicts.
public struct ConflictBannerText: Equatable, Sendable {
    public static let maxVisibleFiles = 8

    public var operation: ConflictOperation
    public var branch: String?
    public var target: String
    public var files: [String]

    public init(operation: ConflictOperation, branch: String?, target: String, files: [String]) {
        self.operation = operation
        self.branch = branch
        self.target = target
        self.files = files
    }

    public var message: String {
        let heading = branch.map { "\(operation.title) in progress: '\($0)' → '\(target)'." }
            ?? "A Git operation with merge conflicts is in progress."
        return "\(heading) Follow-ups are allowed; some actions may be temporarily unavailable until you resolve the conflicts or abort the \(operation.title.lowercased())."
    }

    public var visibleFiles: [String] { Array(files.prefix(Self.maxVisibleFiles)) }

    public var filesHeading: String {
        let more = files.count > visibleFiles.count ? " of \(files.count)" : ""
        return "Conflicted files (\(visibleFiles.count)\(more)):"
    }

    public var abortTitle: String { "Abort \(operation.title)" }
}
