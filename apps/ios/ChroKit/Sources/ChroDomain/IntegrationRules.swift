import Foundation

/// The Rebase onto / Merge into buttons of Source Control
/// (source-control-panel.tsx). The buttons stay visible in a worktree scope;
/// each says why it is inert instead of hiding.
public struct IntegrationState: Equatable, Sendable {
    /// The run's target branch; nil until the server reports it.
    public var targetBranch: String?
    /// Against the target branch (not the upstream that drives Push/Pull).
    public var commitsAhead: Int
    public var commitsBehind: Int
    public var conflictedFileCount: Int
    public var isRebaseInProgress: Bool
    public var isRebasing: Bool
    public var isMerging: Bool
    public var didMerge: Bool

    public init(targetBranch: String?, commitsAhead: Int, commitsBehind: Int, conflictedFileCount: Int, isRebaseInProgress: Bool,
                isRebasing: Bool = false, isMerging: Bool = false, didMerge: Bool = false) {
        self.targetBranch = targetBranch
        self.commitsAhead = commitsAhead
        self.commitsBehind = commitsBehind
        self.conflictedFileCount = conflictedFileCount
        self.isRebaseInProgress = isRebaseInProgress
        self.isRebasing = isRebasing
        self.isMerging = isMerging
        self.didMerge = didMerge
    }

    /// A half-finished history rewrite makes integration unsafe.
    public var isBlocked: Bool { conflictedFileCount > 0 || isRebaseInProgress }
    private var base: String { targetBranch ?? "base" }

    public var canRebase: Bool { targetBranch != nil && !isBlocked && !isRebasing && commitsBehind > 0 }
    public var canMerge: Bool { targetBranch != nil && !isBlocked && !isMerging && commitsAhead > 0 }

    public var rebaseLabel: String { isRebasing ? "Rebasing…" : "Rebase onto \(base)" }
    public var mergeLabel: String { isMerging ? "Merging…" : didMerge ? "Merged" : "Merge into \(base)" }
    public var rebaseBadge: String? { commitsBehind > 0 ? "\(commitsBehind) behind" : nil }
    public var mergeBadge: String? { commitsAhead > 0 ? "\(commitsAhead) ahead" : nil }

    public var rebaseHint: String {
        if isBlocked { return "Resolve the in-progress rebase first" }
        guard targetBranch != nil else { return "Waiting for the run's target branch" }
        return commitsBehind == 0 ? "Already up to date with \(base)" : "Replay this branch on top of \(base)"
    }

    public var mergeHint: String {
        if isBlocked { return "Resolve the in-progress rebase first" }
        guard targetBranch != nil else { return "Waiting for the run's target branch" }
        if commitsAhead == 0 { return "No commits to merge yet" }
        return commitsBehind > 0 ? "Replay this branch on top of \(base), then merge it" : "Merge this branch into \(base)"
    }

    public var blockedNotice: String? {
        if conflictedFileCount > 0 {
            return "Resolve \(conflictedFileCount) conflicted \(conflictedFileCount == 1 ? "file" : "files") to continue"
        }
        return isRebaseInProgress ? "Finish the in-progress rebase to continue" : nil
    }
}
