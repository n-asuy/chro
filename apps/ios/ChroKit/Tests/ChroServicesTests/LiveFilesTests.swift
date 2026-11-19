import ChroAPI
import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// FilesService over the link: the desktop's file routes, the run a session
/// reads, the run diff and the repo events.
@Suite(.timeLimit(.minutes(1)))
struct LiveFilesTests {
    let desktop = FakeDesktop()
    static let project = FakeDesktop.panelProject
    static let session = FakeDesktop.panelSession

    private func service() async throws -> (FilesLiveService, PanelLiveCalls) {
        let (_, calls) = try await desktop.panelPhone()
        return (FilesLiveService(calls: calls), calls)
    }

    @Test func theLiveBundleUsesTheLinkForEveryPanel() async throws {
        let (phone, _) = try await desktop.panelPhone()
        let services = PanelServices.live(phone.workspace)
        #expect(services.files is FilesLiveService)
        #expect(services.sourceControl is SourceControlLiveService)
        #expect(services.editor is EditorLiveService)
        #expect(services.gallery is GalleryLiveService)
        #expect(services.skills is SkillsLiveService)
        #expect(services.settings is SettingsLiveService)
        #expect(services.system is SystemLiveService)
        desktop.reply("GET /rpc/projects/\(Self.project)/entries", ["entries": []])
        #expect(try await services.files.entries(.project(id: Self.project)).isEmpty)
    }

    @Test func projectEntriesAreTheRecursiveTreeFlattened() async throws {
        desktop.reply("GET /rpc/projects/\(Self.project)/entries", ["entries": [
            ["type": "directory", "name": "src", "displayName": "src", "relativePath": "src", "extension": NSNull(), "children": [
                ["type": "file", "name": "stock.ts", "displayName": "stock.ts", "relativePath": "src/stock.ts", "extension": "ts"],
            ]],
            ["type": "file", "name": "README.md", "displayName": "README.md", "relativePath": "README.md", "extension": "md"],
        ]])
        let (files, _) = try await service()
        let entries = try await files.entries(.project(id: Self.project))
        #expect(entries == [
            FileTreeEntry(path: "README.md", isDirectory: false),
            FileTreeEntry(path: "src", isDirectory: true),
            FileTreeEntry(path: "src/stock.ts", isDirectory: false),
        ])
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.project)/entries").first?.query == ["recursive": "true"])
    }

    @Test func aSessionReadsItsRunningRunElseItsNewest() async throws {
        desktop.runs(Self.session, [
            FakeDesktop.run("run-old", createdAt: "2026-11-14T08:00:00Z", container: "/wt/old"),
            FakeDesktop.run("run-new", createdAt: "2026-11-14T10:00:00Z", container: "/wt/new"),
            FakeDesktop.run("run-live", status: "running", createdAt: "2026-11-14T09:00:00Z", container: "/wt/live"),
        ])
        desktop.reply("GET /rpc/task-runs/run-live/entries", ["entries": []])
        let (files, _) = try await service()
        #expect(try await files.entries(.run(sessionID: Self.session)) == [])
        #expect(try await files.checkoutRoot(.run(sessionID: Self.session)) == "/wt/live")
        #expect(try await files.checkoutRoot(.project(id: Self.project)) == "/Users/me/inventory-service")

        desktop.runs(Self.session, [FakeDesktop.run("run-old", createdAt: "2026-11-14T08:00:00Z"), FakeDesktop.run("run-new", createdAt: "2026-11-14T10:00:00Z", container: "/wt/new")])
        // Cached until the session's task row changes.
        #expect(try await files.checkoutRoot(.run(sessionID: Self.session)) == "/wt/live")
        var task = FakeDesktop.task(Self.session, project: Self.project, title: "Add removeStock", updatedAt: "2026-11-14T11:00:00.000Z")
        task["branch"] = "ch/aaaa-add"
        try await desktop.upsertTask(task)
        try await eventually("cache dropped") { (try? await files.checkoutRoot(.run(sessionID: Self.session))) == "/wt/new" }
    }

    @Test func aSessionWithoutRunsIsNotFound() async throws {
        desktop.runs(Self.session, [])
        let (files, _) = try await service()
        await #expect(throws: ServiceError.notFound("Run")) { try await files.entries(.run(sessionID: Self.session)) }
    }

    @Test func changedPathsAreTheRunDiffsFirstSnapshotInStatsOnlyMode() async throws {
        desktop.runs(Self.session, [FakeDesktop.run("run-1", createdAt: "2026-11-14T08:00:00Z")])
        desktop.edit {
            $0.streamSnapshots[FakeDesktop.streamKey("/rpc/task-runs/:id/diff", id: "run-1")] = [
                FakeDesktop.patch([["op": "add", "path": "/diffs/src~1stock.ts", "value": ["type": "DIFF", "content": [
                    "change": "modified", "old_path": "src/stock.ts", "new_path": "src/stock.ts", "content_omitted": true, "additions": 7, "deletions": 0]]]]),
                FakeDesktop.patch([["op": "add", "path": "/diffs/README.md", "value": ["type": "DIFF", "content": [
                    "change": "added", "new_path": "README.md", "content_omitted": true]]]]),
                FakeDesktop.patch([]),
            ]
        }
        let (files, _) = try await service()
        #expect(try await files.changedPaths(sessionID: Self.session) == ["README.md", "src/stock.ts"])
        let subscription = desktop.responders.flatMap(\.subscriptions).first { $0.stream == "/rpc/task-runs/:id/diff" }
        #expect(subscription?.params == ["id": "run-1", "stats_only": "1"] || subscription?.params == ["id": "run-1", "stats_only": "true"])
    }

    @Test func contentSearchSendsTheDesktopsQueryAndReadsTheTotals() async throws {
        desktop.reply("GET /rpc/projects/\(Self.project)/search", [
            "results": [["path": "src/stock.ts", "is_file": true, "match_type": "ContentMatch", "modified_at": "2026-11-14T09:00:00Z",
                         "line_matches": [["line_number": 7, "line_content": "export function removeStock(", "ranges": [[16, 27]]]]]],
            "total_files": 3, "total_line_matches": 9, "truncated": true,
        ])
        let (files, _) = try await service()
        let results = try await files.searchContent(projectID: Self.project, query: "removeStock", matchCase: true, sort: .pathAscending, limit: 200)
        #expect(results.totalFiles == 3)
        #expect(results.totalLineMatches == 9)
        #expect(results.truncated)
        #expect(results.hits.first?.lines == [FileLineMatch(lineNumber: 7, text: "export function removeStock(", ranges: [16..<27])])
        #expect(results.hits.first?.modifiedAt == RFC3339.parse("2026-11-14T09:00:00Z"))
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.project)/search").last?.query
            == ["q": "removeStock", "kind": "content", "limit": "200", "sort": "path-asc", "case": "sensitive"])

        _ = try await files.searchContent(projectID: Self.project, query: "stock", matchCase: false, sort: .relevance, limit: 200)
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.project)/search").last?.query["case"] == nil)
        #expect(try await files.searchContent(projectID: Self.project, query: "  ", matchCase: false, sort: .relevance, limit: 200) == .empty)
    }

    @Test func anInvalidQueryIsTheServersMessage() async throws {
        desktop.edit { $0.failures["/rpc/projects/\(Self.project)/search"] = (400, "bad request: invalid regex /(/") }
        let (files, _) = try await service()
        await #expect(throws: ServiceError.invalid("bad request: invalid regex /(/")) {
            try await files.searchContent(projectID: Self.project, query: "/(/", matchCase: false, sort: .relevance, limit: 200)
        }
    }

    @Test func nameSearchIsKindNameAndSkipsAnEmptyQuery() async throws {
        desktop.reply("GET /rpc/projects/\(Self.project)/search", ["results": [
            ["path": "src", "is_file": false, "match_type": "DirectoryName", "line_matches": [], "modified_at": NSNull()],
        ], "total_files": 1, "total_line_matches": 0, "truncated": false])
        let (files, _) = try await service()
        #expect(try await files.searchNames(projectID: Self.project, query: "", limit: 60) == [])
        #expect(try await files.searchNames(projectID: Self.project, query: "sr", limit: 60) == [FileSearchHit(path: "src", isFile: false)])
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.project)/search").map(\.query) == [["q": "sr", "kind": "name", "limit": "60"]])
    }

    @Test func writesUseTheDesktopsRoutesAndBodies() async throws {
        let base = "/rpc/projects/\(Self.project)"
        desktop.reply("PUT \(base)/file", ["file": ["relative_path": "docs/New file.md", "content": "", "size": 0]])
        desktop.reply("POST \(base)/directory", ["entry": ["type": "directory", "name": "New folder", "relativePath": "New folder"]])
        desktop.reply("POST \(base)/rename", ["new_relative_path": "src/b.ts"])
        desktop.reply("POST \(base)/copy", ["entry": ["type": "file", "name": "a copy.ts", "relativePath": "src/a copy.ts"]])
        desktop.reply("DELETE \(base)/file", ["deleted_path": "src/a.ts"])
        let (files, _) = try await service()
        try await files.createFile(projectID: Self.project, path: "docs/New file.md", content: "")
        try await files.createDirectory(projectID: Self.project, path: "New folder")
        try await files.rename(projectID: Self.project, from: "src/a.ts", to: "src/b.ts")
        try await files.copy(projectID: Self.project, from: "src/a.ts", to: "src/a copy.ts")
        try await files.delete(projectID: Self.project, path: "src/a.ts")
        func body(_ method: String, _ path: String) -> [String: String]? { desktop.requests(method, path).first?.bodyObject as? [String: String] }
        #expect(body("PUT", "\(base)/file") == ["relative_path": "docs/New file.md", "content": ""])
        #expect(body("POST", "\(base)/directory") == ["relative_path": "New folder"])
        #expect(body("POST", "\(base)/rename") == ["old_relative_path": "src/a.ts", "new_relative_path": "src/b.ts"])
        #expect(body("POST", "\(base)/copy") == ["source_relative_path": "src/a.ts", "dest_relative_path": "src/a copy.ts"])
        #expect(desktop.requests("DELETE", "\(base)/file").first?.query == ["relative_path": "src/a.ts"])
    }

    @Test func aRefusedWriteThrowsTheServersText() async throws {
        desktop.edit { $0.failures["/rpc/projects/\(Self.project)/rename"] = (409, "destination already exists") }
        let (files, _) = try await service()
        await #expect(throws: ServiceError.refused("destination already exists")) {
            try await files.rename(projectID: Self.project, from: "a", to: "b")
        }
    }

    @Test func theDirectoryAgentReadsBriefsAndTheLedger() async throws {
        desktop.reply("GET /rpc/projects/\(Self.project)/directory-agent", [
            "path": "src", "brief": NSNull(), "inheritedBrief": ["path": "AGENTS.md"],
            "ledger": [["taskId": "t-1", "slug": NSNull(), "title": "Add removeStock", "summary": "Done.", "outcome": "merged", "updatedAt": "2026-11-14T09:00:00Z"]],
        ])
        let (files, _) = try await service()
        let agent = try await files.directoryAgent(projectID: Self.project, path: "src")
        #expect(agent.path == "src")
        #expect(agent.brief == nil)
        #expect(agent.inheritedBrief == "AGENTS.md")
        #expect(agent.ledger == [.init(sessionID: "t-1", title: "Add removeStock", summary: "Done.", outcome: .merged,
                                       updatedAt: RFC3339.parse("2026-11-14T09:00:00Z")!)])
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.project)/directory-agent").first?.query == ["path": "src"])
    }

    @Test func pathProbesAskTheTaskOrTheProject() async throws {
        desktop.reply("POST /rpc/tasks/\(Self.session)/probe-paths", ["results": [
            ["exists": true, "kind": "file", "absolute_path": "/wt/a/src/stock.ts", "root": "/wt/a", "relative_path": "src/stock.ts", "line": 7, "column": NSNull()],
            ["exists": false],
        ]])
        desktop.reply("POST /rpc/projects/\(Self.project)/probe-paths", ["results": []])
        let (files, _) = try await service()
        let results = try await files.probePaths(["src/stock.ts:7", "nope.ts"], in: .run(sessionID: Self.session))
        #expect(results.map(\.exists) == [true, false])
        #expect(results.first?.relativePath == "src/stock.ts")
        #expect(results.first?.line == 7)
        #expect(desktop.requests("POST", "/rpc/tasks/\(Self.session)/probe-paths").first?.bodyObject as? [String: [String]] == ["paths": ["src/stock.ts:7", "nope.ts"]])
        #expect(try await files.probePaths([], in: .project(id: Self.project)).isEmpty)
        #expect(desktop.requests("POST", "/rpc/projects/\(Self.project)/probe-paths").isEmpty)
    }

    @Test func changesFireOnSubscriptionAndOnFileEventsOnly() async throws {
        let (files, _) = try await service()
        let counter = Counter()
        let task = Task { for await _ in files.changes(.project(id: Self.project)) { counter.add() } }
        defer { task.cancel() }
        try await eventually("initial") { counter.value == 1 }
        let stream = "/streams/projects/:project_id/repo-events"
        try await eventually("subscribed") { desktop.responders.flatMap(\.subscriptions).contains { $0.stream == stream && $0.params == ["project_id": Self.project] } }
        func event(_ payload: [String: Any]) async throws {
            for responder in desktop.responders {
                for subscription in responder.subscriptions where subscription.stream == stream {
                    try await responder.push(FakeDesktop.text(["type": "repo_event", "payload": payload]), to: subscription.subscriptionId)
                }
            }
        }
        try await event(["channel": "git", "kinds": ["headMoved"]])
        try await event(["channel": "files", "paths": ["a.ts"]])
        try await event(["channel": "files", "paths": ["b.ts"]])
        try await eventually("one debounced invalidation") { counter.value == 2 }
        try await Task.sleep(for: .milliseconds(450))
        #expect(counter.value == 2)
        try await event(["channel": "resync"])
        try await eventually("resync") { counter.value == 3 }
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func add() { lock.withLock { count += 1 } }
}
