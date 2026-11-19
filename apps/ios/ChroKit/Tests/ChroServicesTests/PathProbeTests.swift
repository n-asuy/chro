import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// Path links: which references a conversation names exist, on the fixture
/// checkouts and over the link (`POST …/probe-paths`).
@Suite(.timeLimit(.minutes(1)))
struct PathProbeTests {
    @Test func fixtureResolvesAgainstTheWorktreeThenTheProject() async throws {
        let files = FilesFixtureService(checkouts: DockFixtureCheckouts())
        let worktree = try await files.checkoutRoot(.run(sessionID: DockFixtureCheckouts.Run.added))
        let results = try await files.probePaths(["src/stock.test.ts:12", "\(worktree)/README.md", "docs", "nope.ts", "src"],
                                                 in: .run(sessionID: DockFixtureCheckouts.Run.added))
        #expect(results[0] == PathProbeResult(exists: true, kind: .file, absolutePath: "\(worktree)/src/stock.test.ts", root: worktree,
                                              relativePath: "src/stock.test.ts", line: 12))
        #expect(results[1].relativePath == "README.md")
        // docs/ exists only in the project's main checkout.
        let main = try await files.checkoutRoot(.project(id: DockFixtureCheckouts.inventoryProjectID))
        #expect(results[2] == PathProbeResult(exists: true, kind: .directory, absolutePath: "\(main)/docs", root: main, relativePath: "docs"))
        #expect(results[3] == PathProbeResult(exists: false))
        #expect(results[4].kind == .directory)
    }

    @Test func liveAsksTheTaskRouteForASession() async throws {
        let desktop = FakeDesktop()
        let session = FakeDesktop.panelSession
        desktop.reply("POST /rpc/tasks/\(session)/probe-paths", ["results": [
            ["exists": true, "kind": "file", "absolute_path": "/wt/src/a.ts", "root": "/wt", "relative_path": "src/a.ts", "line": 3],
            ["exists": false],
        ]])
        let (_, calls) = try await desktop.panelPhone()
        let results = try await FilesLiveService(calls: calls).probePaths(["src/a.ts:3", "b.ts"], in: .run(sessionID: session))
        #expect(results == [
            PathProbeResult(exists: true, kind: .file, absolutePath: "/wt/src/a.ts", root: "/wt", relativePath: "src/a.ts", line: 3),
            PathProbeResult(exists: false),
        ])
        let request = try #require(desktop.requests("POST", "/rpc/tasks/\(session)/probe-paths").first)
        #expect(request.bodyObject as? [String: [String]] == ["paths": ["src/a.ts:3", "b.ts"]])
    }

    @Test func liveAsksTheProjectRouteForAProject() async throws {
        let desktop = FakeDesktop()
        let project = FakeDesktop.panelProject
        desktop.reply("POST /rpc/projects/\(project)/probe-paths", ["results": [["exists": true, "kind": "directory", "absolute_path": "/p/docs"]]])
        let (_, calls) = try await desktop.panelPhone()
        let results = try await FilesLiveService(calls: calls).probePaths(["docs"], in: .project(id: project))
        #expect(results == [PathProbeResult(exists: true, kind: .directory, absolutePath: "/p/docs")])
    }
}
