import Foundation

/// lib/git-error.ts resolveGitError: turns a failed git operation's message
/// into a sentence the user can act on. The first matching rule wins; an
/// unmatched message is quoted; an empty one names the verb that failed.
public enum GitErrorMessage {
    /// The verb that failed, used only when the error carries nothing quotable.
    public enum Fallback: Sendable {
        case status, stage, unstage, commit, push, pull, discard, discardFiles, rebase, merge, abort

        var message: String {
            switch self {
            case .status: return "Failed to load Git status."
            case .stage: return "Failed to stage files."
            case .unstage: return "Failed to unstage files."
            case .commit: return "Failed to commit."
            case .push: return "Failed to push."
            case .pull: return "Failed to pull."
            case .discard: return "Failed to discard changes."
            case .discardFiles: return "Failed to discard selected files."
            case .rebase: return "Rebase failed."
            case .merge: return "Failed to merge changes."
            case .abort: return "Failed to abort."
            }
        }
    }

    private static let pushRejectHints = ["fetch first", "non-fast-forward", "remote contains work", "failed to push some refs", "rejected"]

    private static let rules: [(hints: [String], message: String)] = [
        (["authentication failed", "could not read username"], "Authentication failed. Check your credentials."),
        (["permission denied", "publickey"], "Permission denied. Check your SSH key or access."),
        (["repository not found"], "Repository not found. Check the remote URL."),
        (["could not read from remote repository", "no such remote"], "Unable to access the remote repository."),
        (["no upstream", "set upstream", "@{u}"], "No upstream branch set. Publish or set upstream."),
        // Read before the broad "conflict" rule, which would otherwise claim it.
        (["nothing to merge"], "Already up to date. This branch has no changes left to merge."),
        (["no commits of its own yet"], "This session continues an earlier one and has no commits of its own yet. Rebasing now would only drop the point it continues from. Commit its work first, or start a new session on the base branch."),
        (["merge conflict", "rebase conflict", "conflict"], "Merge conflict detected. Resolve conflicts and retry."),
        (["rebase in progress"], "Rebase in progress. Resolve or abort before retrying."),
        (["not a git repository"], "This folder is not a Git repository."),
        (["could not resolve host", "failed to connect", "connection timed out", "unable to access"], "Network error. Check your connection."),
        (["local changes would be overwritten"], "Local changes would be overwritten. Commit or stash first."),
    ]

    public static func resolve(_ message: String?, fallback: Fallback) -> String {
        let normalized = normalize(message ?? "")
        let lower = normalized.lowercased()
        if lower.contains("git push") && pushRejectHints.contains(where: lower.contains) {
            return "Remote has new changes. Pull before pushing."
        }
        if let rule = rules.first(where: { $0.hints.contains(where: lower.contains) }) {
            return rule.message
        }
        return normalized.isEmpty ? fallback.message : "Git error: \(normalized)"
    }

    private static func normalize(_ message: String) -> String {
        var text = message
        if let range = text.range(of: #"^bad request:\s*"#, options: [.regularExpression, .caseInsensitive]) {
            text.removeSubrange(range)
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
