import ChroDomain
import Foundation

/// A file's change kind in `git status` (lib/git-client.ts FileChangeStatus).
public enum GitFileStatus: String, Equatable, Sendable {
    case added, modified, deleted, renamed, copied, typechange

    /// The status of a diff entry (`permission_change` reads as a type change).
    public init(_ kind: FileChange.Kind) {
        switch kind {
        case .added: self = .added
        case .deleted: self = .deleted
        case .modified: self = .modified
        case .renamed: self = .renamed
        case .copied: self = .copied
        case .permissionChange: self = .typechange
        }
    }
}

public struct GitFileEntry: Equatable, Sendable, Identifiable {
    public var path: String
    public var status: GitFileStatus
    public var id: String { path }

    public init(path: String, status: GitFileStatus) {
        self.path = path
        self.status = status
    }
}

/// `GET …/git/status` (GitStatusResponse): the working tree against HEAD and
/// the branch against its upstream (Push/Pull counts).
public struct GitStatusSnapshot: Equatable, Sendable {
    public var staged: [GitFileEntry]
    public var modified: [GitFileEntry]
    public var untracked: [String]
    /// nil while detached (mid-rebase) or unknown.
    public var currentBranch: String?
    public var commitsAhead: Int
    public var commitsBehind: Int

    public init(staged: [GitFileEntry], modified: [GitFileEntry], untracked: [String], currentBranch: String?, commitsAhead: Int, commitsBehind: Int) {
        self.staged = staged
        self.modified = modified
        self.untracked = untracked
        self.currentBranch = currentBranch
        self.commitsAhead = commitsAhead
        self.commitsBehind = commitsBehind
    }

    public var hasChanges: Bool { !staged.isEmpty || !modified.isEmpty || !untracked.isEmpty }
}

/// `GET /rpc/task-runs/:id/branch-status`: the run's branch against its target branch.
public struct BranchStatus: Equatable, Sendable {
    public var commitsAhead: Int?
    public var commitsBehind: Int?
    public var targetBranch: String?
    public var isRebaseInProgress: Bool
    public var conflictedFiles: [String]
    /// How many merges of this run landed (`merges`).
    public var mergeCount: Int

    public init(commitsAhead: Int?, commitsBehind: Int?, targetBranch: String?, isRebaseInProgress: Bool, conflictedFiles: [String], mergeCount: Int) {
        self.commitsAhead = commitsAhead
        self.commitsBehind = commitsBehind
        self.targetBranch = targetBranch
        self.isRebaseInProgress = isRebaseInProgress
        self.conflictedFiles = conflictedFiles
        self.mergeCount = mergeCount
    }
}

/// A git verb the server refused. `message` is the server's text, which the
/// screens turn into a sentence with `GitErrorMessage.resolve`.
public enum SourceControlError: Error, Equatable, Sendable {
    case git(String)
}

/// Source Control for a checkout and the integration verbs and diff of a
/// session's run. Every call maps to an allowlisted endpoint
/// (crates/server/src/mobile/allowlist.rs, family SourceControl):
///
/// | method | endpoint |
/// |---|---|
/// | `status` | `GET …/git/status` |
/// | `changes(base:)` | `GET …/git/diff?base=` (no base: uncommitted only) |
/// | `stage` / `unstage` | `POST …/git/stage` / `…/git/unstage` `{paths}` |
/// | `commit` | `POST …/git/commit` `{message}` |
/// | `push` / `pull` | `POST …/git/push` / `…/git/pull` |
/// | `discardAll` / `discard` | `POST …/git/discard` / `…/git/discard-files` `{paths}` |
/// | `branchStatus` | `GET /rpc/task-runs/:id/branch-status` |
/// | `rebase` | `POST /rpc/task-runs/:id/rebase` `{new_base_branch, old_base_branch}` |
/// | `merge` | `POST /rpc/task-runs/:id/merge` `{}` |
/// | `abortConflicts` | `POST /rpc/task-runs/:id/conflicts/abort` |
/// | `runDiff` | subscribe `/rpc/task-runs/:id/diff` (first snapshot) |
/// | `fileData` | `GET …/binary-file?path=` |
/// | `updates` | subscribe `…/repo-events` |
///
/// `…` is `/rpc/projects/:project_id` or `/rpc/task-runs/:id` per `CheckoutScope`.
/// Git refusals throw `SourceControlError.git`; anything else is unexpected.
public protocol SourceControlService: Sendable {
    func status(_ scope: CheckoutScope) async throws -> GitStatusSnapshot
    func changes(_ scope: CheckoutScope, base: String?) async throws -> [FileChange]
    func stage(_ scope: CheckoutScope, paths: [String]) async throws -> GitStatusSnapshot
    func unstage(_ scope: CheckoutScope, paths: [String]) async throws -> GitStatusSnapshot
    func commit(_ scope: CheckoutScope, message: String) async throws
    func push(_ scope: CheckoutScope) async throws -> GitStatusSnapshot
    func pull(_ scope: CheckoutScope) async throws -> GitStatusSnapshot
    func discardAll(_ scope: CheckoutScope) async throws -> GitStatusSnapshot
    func discard(_ scope: CheckoutScope, paths: [String]) async throws -> GitStatusSnapshot
    func branchStatus(sessionID: String) async throws -> BranchStatus
    func rebase(sessionID: String, onto base: String) async throws
    func merge(sessionID: String) async throws
    func abortConflicts(sessionID: String) async throws
    func runDiff(sessionID: String) async throws -> [FileChange]
    func fileData(_ scope: CheckoutScope, path: String) async throws -> Data
    /// Fires once at subscription, then whenever the checkout or its git state changes.
    func updates(_ scope: CheckoutScope) -> AsyncStream<Void>
}
