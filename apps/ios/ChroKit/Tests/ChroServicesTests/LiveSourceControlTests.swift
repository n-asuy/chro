import ChroAPI
import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// SourceControlService over the link: git routes per scope, the run's
/// integration verbs, the diff stream and the repo events.
@Suite(.timeLimit(.minutes(1)))
struct LiveSourceControlTests {
    let desktop = FakeDesktop()
    static let project = FakeDesktop.panelProject
    static let session = FakeDesktop.panelSession

    init() {
        desktop.runs(Self.session, [FakeDesktop.run("run-1", createdAt: "2026-11-14T08:00:00Z", container: "/wt/a")])
    }

    private func service() async throws -> SourceControlLiveService {
        SourceControlLiveService(calls: try await desktop.panelPhone().calls)
    }

    nonisolated(unsafe) static let statusBody: [String: Any] = [
        "status": ["staged": [["path": "a.ts", "status": "added"]], "modified": [["path": "b.ts", "status": "typechange"]],
                   "untracked": ["c.ts"], "hasChanges": true],
        "currentBranch": "ch/aaaa-add", "commitsAhead": 2, "commitsBehind": 1,
    ]

    static let snapshot = GitStatusSnapshot(staged: [GitFileEntry(path: "a.ts", status: .added)], modified: [GitFileEntry(path: "b.ts", status: .typechange)],
                                            untracked: ["c.ts"], currentBranch: "ch/aaaa-add", commitsAhead: 2, commitsBehind: 1)

    @Test func statusReadsTheProjectOrTheRunsCheckout() async throws {
        desktop.reply("GET /rpc/projects/\(Self.project)/git/status", Self.statusBody)
        desktop.reply("GET /rpc/task-runs/run-1/git/status", Self.statusBody)
        let git = try await service()
        #expect(try await git.status(.project(id: Self.project)) == Self.snapshot)
        #expect(try await git.status(.run(sessionID: Self.session)) == Self.snapshot)
    }

    @Test func verbsPostTheDesktopsBodiesAndReturnTheNewStatus() async throws {
        let base = "/rpc/task-runs/run-1/git"
        for verb in ["stage", "unstage", "push", "pull", "discard", "discard-files"] { desktop.reply("POST \(base)/\(verb)", Self.statusBody) }
        desktop.reply("POST \(base)/commit", ["commitSha": "abc"])
        let git = try await service()
        let scope = CheckoutScope.run(sessionID: Self.session)
        #expect(try await git.stage(scope, paths: ["a.ts"]) == Self.snapshot)
        #expect(try await git.unstage(scope, paths: ["a.ts"]) == Self.snapshot)
        try await git.commit(scope, message: "Add removeStock")
        #expect(try await git.push(scope) == Self.snapshot)
        #expect(try await git.pull(scope) == Self.snapshot)
        #expect(try await git.discardAll(scope) == Self.snapshot)
        #expect(try await git.discard(scope, paths: ["b.ts"]) == Self.snapshot)
        func body(_ verb: String) -> NSDictionary? { desktop.requests("POST", "\(base)/\(verb)").first?.bodyObject as? NSDictionary }
        #expect(body("stage") == ["paths": ["a.ts"]] as NSDictionary)
        #expect(body("unstage") == ["paths": ["a.ts"]] as NSDictionary)
        #expect(body("commit") == ["message": "Add removeStock"] as NSDictionary)
        #expect(body("discard-files") == ["paths": ["b.ts"]] as NSDictionary)
        for verb in ["push", "pull", "discard"] { #expect(desktop.requests("POST", "\(base)/\(verb)").first?.body == nil, "\(verb) sends no body") }
    }

    @Test func aRefusedVerbIsAGitErrorWithTheServersText() async throws {
        desktop.edit { $0.failures["/rpc/task-runs/run-1/git/push"] = (400, "bad request: git push rejected (fetch first)") }
        let git = try await service()
        await #expect(throws: SourceControlError.git("bad request: git push rejected (fetch first)")) {
            try await git.push(.run(sessionID: Self.session))
        }
    }

    @Test func workingDiffsCarryTheBase() async throws {
        desktop.reply("GET /rpc/projects/\(Self.project)/git/diff", ["diffs": [["path": "README.md", "diff": [
            "change": "modified", "old_path": "README.md", "new_path": "README.md", "old_content": "a\n", "new_content": "a\nb\n",
            "content_omitted": false, "additions": 1, "deletions": 0, "is_binary": false]]]])
        let git = try await service()
        let changes = try await git.changes(.project(id: Self.project), base: "main")
        #expect(changes == [FileChange(kind: .modified, oldPath: "README.md", newPath: "README.md", oldContent: "a\n", newContent: "a\nb\n",
                                       additions: 1, deletions: 0)])
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.project)/git/diff").first?.query == ["base": "main"])
        _ = try await git.changes(.project(id: Self.project), base: nil)
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.project)/git/diff").last?.query == [:])
    }

    @Test func branchStatusAndTheIntegrationVerbs() async throws {
        desktop.reply("GET /rpc/task-runs/run-1/branch-status", [
            "commits_ahead": 1, "commits_behind": 2, "target_branch": "main", "is_rebase_in_progress": true,
            "merges": [["id": "m-1"]], "conflicted_files": ["README.md"], "conflict_op": "rebase",
        ])
        desktop.reply("POST /rpc/task-runs/run-1/rebase", ["status": "ok"])
        desktop.reply("POST /rpc/task-runs/run-1/merge", ["status": "ok"])
        desktop.edit { $0.replies["POST /rpc/task-runs/run-1/conflicts/abort"] = .empty(status: 204) }
        let git = try await service()
        #expect(try await git.branchStatus(sessionID: Self.session)
            == BranchStatus(commitsAhead: 1, commitsBehind: 2, targetBranch: "main", isRebaseInProgress: true, conflictedFiles: ["README.md"], mergeCount: 1))
        try await git.rebase(sessionID: Self.session, onto: "main")
        try await git.merge(sessionID: Self.session)
        try await git.abortConflicts(sessionID: Self.session)
        #expect(desktop.requests("POST", "/rpc/task-runs/run-1/rebase").first?.bodyObject as? [String: String]
            == ["new_base_branch": "main", "old_base_branch": "main"])
        #expect((desktop.requests("POST", "/rpc/task-runs/run-1/merge").first?.bodyObject as? [String: Any])?.isEmpty == true)
        #expect(desktop.requests("POST", "/rpc/task-runs/run-1/conflicts/abort").count == 1)
    }

    @Test func aConflictingRebaseIsAGitError() async throws {
        desktop.edit { $0.failures["/rpc/task-runs/run-1/rebase"] = (409, "rebase conflict in README.md") }
        let git = try await service()
        await #expect(throws: SourceControlError.git("rebase conflict in README.md")) { try await git.rebase(sessionID: Self.session, onto: "main") }
    }

    @Test func theRunDiffIsTheFirstSnapshotWithContents() async throws {
        desktop.edit {
            $0.streamSnapshots[FakeDesktop.streamKey("/rpc/task-runs/:id/diff", id: "run-1")] = [
                FakeDesktop.patch([["op": "add", "path": "/diffs/docs~1a.png", "value": ["type": "DIFF", "content": [
                    "change": "added", "new_path": "docs/a.png", "content_omitted": false, "is_binary": true]]]]),
                FakeDesktop.patch([]),
            ]
        }
        let git = try await service()
        #expect(try await git.runDiff(sessionID: Self.session)
            == [FileChange(kind: .added, oldPath: nil, newPath: "docs/a.png", oldContent: nil, newContent: nil, isBinary: true)])
        let subscription = desktop.responders.flatMap(\.subscriptions).first { $0.stream == "/rpc/task-runs/:id/diff" }
        #expect(["0", "false"].contains(subscription?.params["stats_only"] ?? ""))
    }

    @Test func aFailedDiffStreamThrows() async throws {
        desktop.edit {
            $0.streamSnapshots[FakeDesktop.streamKey("/rpc/task-runs/:id/diff", id: "run-1")] = [FakeDesktop.text(["error": "worktree is gone"])]
        }
        let git = try await service()
        await #expect(throws: ServiceError.unavailable("worktree is gone")) { try await git.runDiff(sessionID: Self.session) }
    }

    @Test func fileDataIsTheBinaryFile() async throws {
        desktop.edit { $0.replies["GET /rpc/projects/\(Self.project)/binary-file"] = .binary(status: 200, contentType: "image/png", Data([1, 2, 3])) }
        let git = try await service()
        #expect(try await git.fileData(.project(id: Self.project), path: "docs/a.png") == Data([1, 2, 3]))
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.project)/binary-file").first?.query == ["relative_path": "docs/a.png"])
    }

    @Test func updatesFollowTheRunsRepoEventsAndResnapshotOnReconnect() async throws {
        let git = try await service()
        let counter = Counter()
        let task = Task { for await _ in git.updates(.run(sessionID: Self.session)) { counter.add() } }
        defer { task.cancel() }
        try await eventually("initial") { counter.value == 1 }
        let stream = "/streams/task-runs/:id/repo-events"
        try await eventually("subscribed") { desktop.responders.flatMap(\.subscriptions).contains { $0.stream == stream && $0.params == ["id": "run-1"] } }
        try await desktop.push(stream, id: "run-1", ["type": "repo_event", "payload": ["channel": "git", "kinds": ["indexChanged"]]])
        try await eventually("git event") { counter.value == 2 }
        // The server ends the stream: the phone subscribes again and refreshes once.
        for responder in desktop.responders {
            for subscription in responder.subscriptions where subscription.stream == stream {
                try await responder.endSubscription(subscription.subscriptionId)
            }
        }
        try await eventually("resubscribed", { counter.value == 3 })
    }
}
