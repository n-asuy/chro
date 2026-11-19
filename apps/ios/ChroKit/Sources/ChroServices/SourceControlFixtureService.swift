import ChroDomain
import Foundation

/// SourceControlService over the mock's checkouts. The captures fix each
/// run's branch, target and ahead/behind counts and the one integration that
/// was recorded: rebasing "Reword README summary" onto main stopped on a
/// conflict in README.md. The outcomes no capture shows (a successful
/// rebase, merge, push, pull or abort) follow what git and the server do:
/// the counts the verb settles drop to zero, an abort restores the branch.
/// A merge lands on the target branch, which the fixture keeps no checkout
/// of, and does not change the session list's fixture sessions.
final class SourceControlFixtureService: SourceControlService, @unchecked Sendable {
    private struct RunGit {
        var branch: String
        var target: String
        var ahead: Int
        var behind: Int
        var mergeCount = 0
        /// Files a rebase onto the target stops on (captured for the reworded run only).
        var conflictsOnRebase: [String] = []
        /// The branch's checkout before a rebase that stopped, restored by abort.
        var interrupted: FixtureCheckout?
        var conflictedFiles: [String] = []
    }

    private struct WorkingTree {
        /// Contents at HEAD; the checkout's nodes are the working tree.
        var head: [String: FixtureNode]
        var staged: Set<String> = []
        /// Upstream counts (Push/Pull).
        var ahead = 0
        var behind = 0
    }

    private let checkouts: DockFixtureCheckouts
    private let options: PanelFixtureOptions
    private let lock = NSLock()
    private var runs: [String: RunGit]
    private var trees: [CheckoutScope: WorkingTree] = [:]

    /// Projects that are git repositories; any other project scope fails like `git status` outside a repository.
    private static let repositories: Set<String> = [DockFixtureCheckouts.inventoryProjectID]

    init(checkouts: DockFixtureCheckouts, options: PanelFixtureOptions) {
        self.checkouts = checkouts
        self.options = options
        typealias Run = DockFixtureCheckouts.Run
        runs = [
            Run.added: RunGit(branch: "ch/e7a6-add-removestock-to-stock", target: "main", ahead: 2, behind: 0),
            Run.review: RunGit(branch: "ch/e7a6-add-removestock-to-stock", target: "main", ahead: 0, behind: 0),
            Run.summarize: RunGit(branch: "ch/4a53-summarize-stock-module", target: "main", ahead: 0, behind: 0),
            Run.images: RunGit(branch: "ch/bd50-add-stock-report-images", target: "main", ahead: 0, behind: 1),
            Run.reworded: RunGit(branch: "ch/c453-reword-readme-summary", target: "main", ahead: 1, behind: 2, conflictsOnRebase: ["README.md"]),
            // Running sessions of the first capture: their worktrees were not captured, so they hold no files.
            "5c1e0f6a-pol": RunGit(branch: "ch/6c96-choose-restock-policy", target: "main", ahead: 0, behind: 0),
            "9b07c2d1-rec": RunGit(branch: "ch/6d40-long-stock-reconciliation-run", target: "main", ahead: 0, behind: 0),
            "e4a2b9c0-aud": RunGit(branch: "ch/67e6-write-audit-marker-outside", target: "main", ahead: 0, behind: 0),
        ]
        // Everything captured is committed: HEAD starts as the checkout's contents.
        let scopes = runs.keys.map { CheckoutScope.run(sessionID: $0) } + Self.repositories.map { CheckoutScope.project(id: $0) }
        for scope in scopes {
            trees[scope] = WorkingTree(head: checkouts.checkout(scope)?.nodes ?? [:])
        }
    }

    // MARK: Working tree

    func status(_ scope: CheckoutScope) async throws -> GitStatusSnapshot {
        try locked { try snapshot(scope) }
    }

    func changes(_ scope: CheckoutScope, base: String?) async throws -> [FileChange] {
        try locked {
            let tree = try workingTree(scope)
            let nodes = checkouts.checkout(scope)?.nodes ?? [:]
            if base == nil { return Self.diff(from: tree.head, to: nodes) }
            switch scope {
            case .run: return Self.diff(from: checkouts.checkout(scope)?.base ?? [:], to: nodes)
            // The main checkout is on main itself: the branch adds nothing, only uncommitted work differs.
            case .project: return Self.diff(from: tree.head, to: nodes)
            }
        }
    }

    func stage(_ scope: CheckoutScope, paths: [String]) async throws -> GitStatusSnapshot {
        try locked {
            try mutateTree(scope) { $0.staged.formUnion(paths) }
            return try snapshot(scope)
        }
    }

    func unstage(_ scope: CheckoutScope, paths: [String]) async throws -> GitStatusSnapshot {
        try locked {
            try mutateTree(scope) { $0.staged.subtract(paths) }
            return try snapshot(scope)
        }
    }

    func commit(_ scope: CheckoutScope, message: String) async throws {
        try locked {
            let nodes = checkouts.checkout(scope)?.nodes ?? [:]
            let tree = try workingTree(scope)
            let staged = tree.staged.filter { Self.differs(tree.head[$0], nodes[$0]) }
            guard !staged.isEmpty else { throw SourceControlError.git("nothing to commit, working tree clean") }
            try mutateTree(scope) { tree in
                for path in staged { tree.head[path] = nodes[path] }
                tree.staged = []
                tree.ahead += 1
            }
            if case .run(let sessionID) = scope { runs[sessionID]?.ahead += 1 }
        }
        bump()
    }

    func push(_ scope: CheckoutScope) async throws -> GitStatusSnapshot {
        try locked {
            try mutateTree(scope) { $0.ahead = 0 }
            return try snapshot(scope)
        }
    }

    func pull(_ scope: CheckoutScope) async throws -> GitStatusSnapshot {
        try locked {
            try mutateTree(scope) { $0.behind = 0 }
            return try snapshot(scope)
        }
    }

    func discardAll(_ scope: CheckoutScope) async throws -> GitStatusSnapshot {
        let paths = try locked { () -> [String] in
            let tree = try workingTree(scope)
            let nodes = checkouts.checkout(scope)?.nodes ?? [:]
            return Set(tree.head.keys).union(nodes.keys).filter { Self.differs(tree.head[$0], nodes[$0]) }.sorted()
        }
        return try await discard(scope, paths: paths)
    }

    func discard(_ scope: CheckoutScope, paths: [String]) async throws -> GitStatusSnapshot {
        let head = try locked { try workingTree(scope).head }
        checkouts.update(scope) { checkout in
            for path in paths { checkout.nodes[path] = head[path] }
        }
        return try locked {
            try mutateTree(scope) { $0.staged.subtract(paths) }
            return try snapshot(scope)
        }
    }

    // MARK: Integration

    func branchStatus(sessionID: String) async throws -> BranchStatus {
        try locked {
            let run = try runGit(sessionID)
            return BranchStatus(commitsAhead: run.ahead, commitsBehind: run.behind, targetBranch: run.target,
                                isRebaseInProgress: run.interrupted != nil, conflictedFiles: run.conflictedFiles, mergeCount: run.mergeCount)
        }
    }

    func rebase(sessionID: String, onto base: String) async throws {
        try replay(sessionID)
    }

    func merge(sessionID: String) async throws {
        let behind = try locked { () -> Int in
            let run = try runGit(sessionID)
            guard run.interrupted == nil else { throw SourceControlError.git("rebase in progress") }
            guard run.ahead > 0 else { throw SourceControlError.git("nothing to merge") }
            return run.behind
        }
        // A branch behind its target is replayed on top of it first.
        if behind > 0 { try replay(sessionID) }
        try locked {
            runs[sessionID]?.ahead = 0
            runs[sessionID]?.mergeCount += 1
        }
        bump()
    }

    func abortConflicts(sessionID: String) async throws {
        let saved = try locked { () -> FixtureCheckout? in
            let run = try runGit(sessionID)
            runs[sessionID]?.interrupted = nil
            runs[sessionID]?.conflictedFiles = []
            return run.interrupted
        }
        if let saved { checkouts.update(.run(sessionID: sessionID)) { $0 = saved } }
        bump()
    }

    /// Replays the branch on its target: stops on the captured conflict, else catches up.
    private func replay(_ sessionID: String) throws {
        let run = try locked { try runGit(sessionID) }
        guard run.interrupted == nil else { throw SourceControlError.git("rebase in progress") }
        guard run.conflictsOnRebase.isEmpty else {
            let scope = CheckoutScope.run(sessionID: sessionID)
            let before = checkouts.checkout(scope)
            // The captured stop: main's README line against the run's, and main's new skill file.
            checkouts.update(scope) { checkout in
                checkout.nodes["README.md"] = .text(DockFixtureCheckouts.Content.readmeConflict.joined(separator: "\n"))
                checkout.nodes[".claude/skills/restock-check/SKILL.md"] = .text(DockFixtureCheckouts.Content.skillMD.joined(separator: "\n"))
                for directory in [".claude", ".claude/skills", ".claude/skills/restock-check"] { checkout.nodes[directory] = .directory }
            }
            locked {
                runs[sessionID]?.interrupted = before
                runs[sessionID]?.conflictedFiles = run.conflictsOnRebase
            }
            bump()
            throw SourceControlError.git("rebase conflict in \(run.conflictsOnRebase.joined(separator: ", "))")
        }
        locked { runs[sessionID]?.behind = 0 }
        bump()
    }

    // MARK: Diff and files

    func runDiff(sessionID: String) async throws -> [FileChange] {
        if options.failingDiffLoad { throw FixtureFault.diffLoad }
        _ = try locked { try runGit(sessionID) }
        let scope = CheckoutScope.run(sessionID: sessionID)
        return Self.diff(from: checkouts.checkout(scope)?.base ?? [:], to: checkouts.checkout(scope)?.nodes ?? [:])
    }

    func fileData(_ scope: CheckoutScope, path: String) async throws -> Data {
        switch checkouts.checkout(scope)?.nodes[path] {
        case .binary(let data, _)?: return data
        case .text(let text)?: return Data(text.utf8)
        case .directory?, nil: throw ServiceError.notFound(path)
        }
    }

    func updates(_ scope: CheckoutScope) -> AsyncStream<Void> {
        let revisions = checkouts.revision.stream()
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                for await _ in revisions { continuation.yield(()) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: Helpers

    private enum FixtureFault: Error, CustomStringConvertible {
        case diffLoad
        var description: String { "Error: the diff stream closed before its first snapshot." }
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    private func bump() { checkouts.revision.update { $0 += 1 } }

    private func runGit(_ sessionID: String) throws -> RunGit {
        guard let run = runs[sessionID] else { throw ServiceError.notFound("Run") }
        return run
    }

    private func workingTree(_ scope: CheckoutScope) throws -> WorkingTree {
        if let tree = trees[scope] { return tree }
        throw SourceControlError.git("fatal: not a git repository (or any of the parent directories): .git")
    }

    private func mutateTree(_ scope: CheckoutScope, _ change: (inout WorkingTree) -> Void) throws {
        var tree = try workingTree(scope)
        change(&tree)
        trees[scope] = tree
    }

    private func snapshot(_ scope: CheckoutScope) throws -> GitStatusSnapshot {
        let tree = try workingTree(scope)
        let nodes = checkouts.checkout(scope)?.nodes ?? [:]
        var staged: [GitFileEntry] = [], modified: [GitFileEntry] = [], untracked: [String] = []
        for path in Set(tree.head.keys).union(nodes.keys).sorted() where Self.differs(tree.head[path], nodes[path]) {
            let status: GitFileStatus = tree.head[path] == nil ? .added : nodes[path] == nil ? .deleted : .modified
            if tree.staged.contains(path) {
                staged.append(GitFileEntry(path: path, status: status))
            } else if status == .added {
                untracked.append(path)
            } else {
                modified.append(GitFileEntry(path: path, status: status))
            }
        }
        let branch: String?
        switch scope {
        case .run(let sessionID):
            let run = runs[sessionID]
            branch = run?.interrupted == nil ? run?.branch : nil
        case .project:
            branch = "main"
        }
        return GitStatusSnapshot(staged: staged, modified: modified, untracked: untracked, currentBranch: branch,
                                 commitsAhead: tree.ahead, commitsBehind: tree.behind)
    }

    /// Folders are not tracked by git; only file contents differ.
    private static func differs(_ a: FixtureNode?, _ b: FixtureNode?) -> Bool {
        if a?.isDirectory == true || b?.isDirectory == true { return false }
        return a != b
    }

    /// File changes between two snapshots, sorted by path, as the server reports them.
    static func diff(from old: [String: FixtureNode], to new: [String: FixtureNode]) -> [FileChange] {
        Set(old.keys).union(new.keys).sorted().compactMap { path -> FileChange? in
            let before = old[path], after = new[path]
            guard differs(before, after) else { return nil }
            let kind: FileChange.Kind = before == nil ? .added : after == nil ? .deleted : .modified
            let isBinary = { (node: FixtureNode?) in if case .binary? = node { true } else { false } }
            if isBinary(before) || isBinary(after) {
                return FileChange(kind: kind, oldPath: before == nil ? nil : path, newPath: after == nil ? nil : path,
                                  oldContent: nil, newContent: nil, additions: 0, deletions: 0, isBinary: true)
            }
            let oldText = before?.text ?? "", newText = after?.text ?? ""
            let stats = DiffHunks.stats(old: oldText, new: newText)
            return FileChange(kind: kind, oldPath: before == nil ? nil : path, newPath: after == nil ? nil : path,
                              oldContent: before?.text, newContent: after?.text, additions: stats.additions, deletions: stats.deletions)
        }
    }
}
