import ChroDomain
import ChroLink
import Foundation

/// SourceControlService over the paired desktop (lib/git-client.ts,
/// hooks/use-branch-status.ts, use-rebase.ts, use-merge-run.ts, the conflict
/// banner's abort, use-diff-stream.ts). Every refusal of a git route throws
/// `SourceControlError.git` with the server's text.
final class SourceControlLiveService: SourceControlService, @unchecked Sendable {
    private let calls: PanelLiveCalls

    init(calls: PanelLiveCalls) { self.calls = calls }

    private func git(_ scope: CheckoutScope) async throws -> [String] { try await calls.base(scope) + ["git"] }

    func status(_ scope: CheckoutScope) async throws -> GitStatusSnapshot {
        try calls.decode(StatusWire.self, try await calls.body(.get, try await git(scope) + ["status"], failure: .git)).snapshot
    }

    func changes(_ scope: CheckoutScope, base: String?) async throws -> [FileChange] {
        let data = try await calls.body(.get, try await git(scope) + ["diff"], query: base.map { ["base": $0] } ?? [:], failure: .git)
        return try calls.decode(DiffList.self, data).diffs.map(\.diff.change)
    }

    func stage(_ scope: CheckoutScope, paths: [String]) async throws -> GitStatusSnapshot {
        try await statusVerb(scope, "stage", body: ["paths": paths])
    }

    func unstage(_ scope: CheckoutScope, paths: [String]) async throws -> GitStatusSnapshot {
        try await statusVerb(scope, "unstage", body: ["paths": paths])
    }

    func commit(_ scope: CheckoutScope, message: String) async throws {
        try await calls.send(.post, try await git(scope) + ["commit"], body: ["message": message], failure: .git)
    }

    func push(_ scope: CheckoutScope) async throws -> GitStatusSnapshot { try await statusVerb(scope, "push") }

    func pull(_ scope: CheckoutScope) async throws -> GitStatusSnapshot { try await statusVerb(scope, "pull") }

    func discardAll(_ scope: CheckoutScope) async throws -> GitStatusSnapshot { try await statusVerb(scope, "discard") }

    func discard(_ scope: CheckoutScope, paths: [String]) async throws -> GitStatusSnapshot {
        try await statusVerb(scope, "discard-files", body: ["paths": paths])
    }

    /// The git verbs that answer the new status (`GitStatusResponse`); push, pull
    /// and discard send no body, as `postJson` without one.
    private func statusVerb(_ scope: CheckoutScope, _ verb: String, body: Any? = nil) async throws -> GitStatusSnapshot {
        try calls.decode(StatusWire.self, try await calls.body(.post, try await git(scope) + [verb], body: body, failure: .git)).snapshot
    }

    func branchStatus(sessionID: String) async throws -> BranchStatus {
        let run = try await calls.run(sessionID: sessionID)
        let wire = try calls.decode(BranchStatusWire.self, try await calls.body(.get, ["rpc", "task-runs", run.id, "branch-status"], failure: .git))
        return BranchStatus(commitsAhead: wire.commitsAhead, commitsBehind: wire.commitsBehind, targetBranch: wire.targetBranch,
                            isRebaseInProgress: wire.isRebaseInProgress, conflictedFiles: wire.conflictedFiles ?? [],
                            mergeCount: wire.merges?.count ?? 0)
    }

    /// `old_base_branch` defaults to the new one, as `useRebase` sends it.
    func rebase(sessionID: String, onto base: String) async throws {
        let run = try await calls.run(sessionID: sessionID)
        try await calls.send(.post, ["rpc", "task-runs", run.id, "rebase"], body: ["new_base_branch": base, "old_base_branch": base], failure: .git)
    }

    func merge(sessionID: String) async throws {
        let run = try await calls.run(sessionID: sessionID)
        try await calls.send(.post, ["rpc", "task-runs", run.id, "merge"], body: [String: Any](), failure: .git)
    }

    func abortConflicts(sessionID: String) async throws {
        let run = try await calls.run(sessionID: sessionID)
        try await calls.send(.post, ["rpc", "task-runs", run.id, "conflicts", "abort"], failure: .git)
    }

    func runDiff(sessionID: String) async throws -> [FileChange] {
        let run = try await calls.run(sessionID: sessionID)
        return try await calls.diffSnapshot(runID: run.id, statsOnly: false)
    }

    func fileData(_ scope: CheckoutScope, path: String) async throws -> Data {
        try await calls.bytes(try await calls.base(scope) + ["binary-file"], query: ["relative_path": path])
    }

    /// Both channels: the working tree and git's own state (HEAD, index, operations).
    func updates(_ scope: CheckoutScope) -> AsyncStream<Void> {
        calls.invalidations(scope, channels: ["files", "git"])
    }

    // MARK: Wire

    /// `GitStatusResponse`.
    private struct StatusWire: Decodable {
        struct Status: Decodable {
            struct Entry: Decodable { let path: String; let status: String }
            let staged: [Entry]
            let modified: [Entry]
            let untracked: [String]
        }

        let status: Status
        let currentBranch: String?
        let commitsAhead: Int
        let commitsBehind: Int

        var snapshot: GitStatusSnapshot {
            func entries(_ list: [Status.Entry]) -> [GitFileEntry] {
                list.map { GitFileEntry(path: $0.path, status: GitFileStatus(rawValue: $0.status) ?? .modified) }
            }
            return GitStatusSnapshot(staged: entries(status.staged), modified: entries(status.modified), untracked: status.untracked,
                                     currentBranch: currentBranch, commitsAhead: commitsAhead, commitsBehind: commitsBehind)
        }
    }

    private struct DiffList: Decodable {
        struct Entry: Decodable { let diff: PanelLiveCalls.WireDiff }
        let diffs: [Entry]
    }

    private struct BranchStatusWire: Decodable {
        let commitsAhead: Int?
        let commitsBehind: Int?
        let targetBranch: String?
        let isRebaseInProgress: Bool
        let conflictedFiles: [String]?
        let merges: [Merge]?

        struct Merge: Decodable { let id: String }

        enum CodingKeys: String, CodingKey {
            case commitsAhead = "commits_ahead", commitsBehind = "commits_behind", targetBranch = "target_branch"
            case isRebaseInProgress = "is_rebase_in_progress", conflictedFiles = "conflicted_files", merges
        }
    }
}
