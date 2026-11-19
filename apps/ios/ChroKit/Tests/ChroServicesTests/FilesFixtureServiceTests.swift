import ChroDomain
import Foundation
import Testing
@testable import ChroServices

private let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)

private func service(_ checkouts: DockFixtureCheckouts = DockFixtureCheckouts(), showsHidden: Bool = true) -> FilesFixtureService {
    FilesFixtureService(checkouts: checkouts, now: { fixedNow }, showsHiddenDirectories: showsHidden)
}

/// The Files, Search and Agent panels' fixture over the mock's checkouts.
struct FilesFixtureServiceTests {
    @Test func capturedHostShowsHiddenFolders() async throws {
        let paths = try await service().entries(.project(id: "inv")).map(\.path)
        #expect(paths.contains(".claude/skills/restock-check/SKILL.md"))
        #expect(paths.contains(".git"))
    }

    @Test func hiddenFoldersAreLeftOutWhenTheSettingIsOff() async throws {
        let paths = try await service(showsHidden: false).entries(.project(id: "inv")).map(\.path)
        #expect(paths.contains("docs/skus/A1.md"))
        #expect(paths.contains("src/stock.ts"))
        #expect(!paths.contains { $0.hasPrefix(".claude") || $0.hasPrefix(".git") })
    }

    @Test func changedPathsCompareTheRunWithItsBase() async throws {
        let files = service()
        #expect(try await files.changedPaths(sessionID: "7a3f5d10-add") == ["README.md", "src/stock.test.ts", "src/stock.ts"])
        #expect(try await files.changedPaths(sessionID: "bd50a1e2-img") ==
            ["docs/images/sku-heatmap.png", "docs/images/stock-trend.svg", "docs/images/warehouse-badge.svg"])
        #expect(try await files.changedPaths(sessionID: "b41c8e33-rev").isEmpty)
    }

    @Test func checkoutRootsAreTheCapturedPaths() async throws {
        let files = service()
        #expect(try await files.checkoutRoot(.project(id: "inv")) == "/private/tmp/mm/iso/inventory-service")
        #expect(try await files.checkoutRoot(.run(sessionID: "7a3f5d10-add")) == "/private/tmp/mm/iso/worktrees/ch/e7a6-add-removestock-to-stock")
    }

    @Test func createRenameCopyAndDeleteChangeTheSharedCheckout() async throws {
        let checkouts = DockFixtureCheckouts()
        let files = service(checkouts)
        try await files.createFile(projectID: "inv", path: "docs/New file.md", content: "")
        try await files.createDirectory(projectID: "inv", path: "docs/New folder")
        try await files.rename(projectID: "inv", from: "docs/skus", to: "docs/items")
        try await files.copy(projectID: "inv", from: "README.md", to: "README copy.md")
        try await files.delete(projectID: "inv", path: "docs/restock-notes.md")
        let nodes = try #require(checkouts.checkout(.project(id: "inv"))).nodes
        #expect(nodes["docs/New file.md"] == .text(""))
        #expect(nodes["docs/New folder"] == .directory)
        #expect(nodes["docs/items/A1.md"] != nil && nodes["docs/skus/A1.md"] == nil && nodes["docs/skus"] == nil)
        #expect(nodes["README copy.md"] == nodes["README.md"])
        #expect(nodes["docs/restock-notes.md"] == nil)
    }

    @Test func refusedOperationsMatchTheServer() async throws {
        let files = service()
        await #expect(throws: ServiceError.self) { try await files.rename(projectID: "inv", from: "README.md", to: "src/stock.ts") }
        await #expect(throws: ServiceError.self) { try await files.createDirectory(projectID: "inv", path: "src") }
        await #expect(throws: ServiceError.self) { try await files.delete(projectID: "inv", path: "missing.md") }
        await #expect(throws: ServiceError.self) { try await files.rename(projectID: "inv", from: "docs", to: "docs/skus/docs") }
    }

    @Test func changesFireOnEdits() async throws {
        let checkouts = DockFixtureCheckouts()
        let files = service(checkouts)
        var iterator = files.changes(.project(id: "inv")).makeAsyncIterator()
        _ = await iterator.next() // the current state
        try await files.createDirectory(projectID: "inv", path: "x")
        #expect(await iterator.next() != nil)
    }

    @Test func contentSearchGroupsLinesWithHighlights() async throws {
        let results = try await service().searchContent(projectID: "inv", query: "stock", matchCase: false, sort: .pathAscending, limit: 50)
        let readme = try #require(results.hits.first { $0.path == "README.md" })
        #expect(readme.lines.first?.lineNumber == 3)
        #expect(readme.lines.first?.text == "Tracks on-hand and reserved stock for every SKU.")
        #expect(readme.lines.first?.ranges == [28..<33])
        #expect(results.totalFiles == results.hits.count)
        #expect(results.totalLineMatches == results.hits.reduce(0) { $0 + $1.lines.count })
        #expect(results.hits.map(\.path) == results.hits.map(\.path).sorted())
        // Hidden folders are searched (the walker only skips .git and build output).
        #expect(results.hits.contains { $0.path == ".claude/skills/restock-check/SKILL.md" })
    }

    @Test func everyMatchingLineCarriesItsText() async throws {
        let results = try await service().searchContent(projectID: "inv", query: "stock", matchCase: false, sort: .relevance, limit: 50)
        let notes = try #require(results.hits.first { $0.path == "docs/restock-notes.md" })
        #expect(notes.lines.map(\.lineNumber) == [4, 6, 9])
        #expect(notes.lines.map(\.text) == ["tags: [restock]", "# Restock notes", "- [x] Draft the low-stock list"])
        #expect(notes.lines.last?.ranges == [20..<25])
    }

    @Test func nameOnlyQueriesReturnFilesWithoutLines() async throws {
        let results = try await service().searchContent(projectID: "inv", query: "file:stock", matchCase: false, sort: .relevance, limit: 50)
        #expect(results.hits.map(\.path) == ["docs/restock-notes.md", "docs/stock-levels.csv", "src/stock.ts"])
        // Binary files (the PDF) are never searched.
        #expect(results.hits.allSatisfy { $0.lines.isEmpty })
    }

    @Test func relevanceRanksNameMatchesFirst() async throws {
        let results = try await service().searchContent(projectID: "inv", query: "stock", matchCase: false, sort: .relevance, limit: 50)
        #expect(results.hits.first?.path == "src/stock.ts")
    }

    @Test func matchCaseForcesSensitivity() async throws {
        let insensitive = try await service().searchContent(projectID: "inv", query: "sku", matchCase: false, sort: .relevance, limit: 50)
        let sensitive = try await service().searchContent(projectID: "inv", query: "sku", matchCase: true, sort: .relevance, limit: 50)
        #expect(insensitive.totalLineMatches > sensitive.totalLineMatches)
    }

    @Test func invalidRegexIsRefused() async {
        await #expect(throws: ServiceError.self) {
            _ = try await service().searchContent(projectID: "inv", query: "/(/", matchCase: false, sort: .relevance, limit: 50)
        }
    }

    @Test func nameSearchFindsFilesAndFolders() async throws {
        let hits = try await service().searchNames(projectID: "inv", query: "sku", limit: 60)
        #expect(hits.contains { $0.path == "docs/skus" && !$0.isFile })
        #expect(hits.contains { $0.path == "docs/skus/A1.md" && $0.isFile })
    }

    @Test func rootAgentListsTheProjectsFinishedSessions() async throws {
        let agent = try await service().directoryAgent(projectID: "inv", path: "")
        #expect(agent.brief == nil && agent.inheritedBrief == nil)
        #expect(agent.ledger.map(\.title) == ["Add stock report images", "Reword README summary", "Add removeStock to stock module",
                                               "Review removeStock in src/stock.ts for edge cases", "Summarize stock module"])
        #expect(agent.ledger.last?.outcome == .failed)
        #expect(agent.ledger.first?.outcome == .completed)
    }

    @Test func subdirectoryAgentHasNoHistory() async throws {
        let agent = try await service().directoryAgent(projectID: "inv", path: "docs")
        #expect(agent.path == "docs")
        #expect(agent.ledger.isEmpty)
    }

    @Test func briefsComeFromTheCheckout() async throws {
        let files = service()
        try await files.createFile(projectID: "inv", path: "AGENTS.md", content: "# Agents")
        #expect(try await files.directoryAgent(projectID: "inv", path: "").brief == "AGENTS.md")
        #expect(try await files.directoryAgent(projectID: "inv", path: "docs/skus").inheritedBrief == "AGENTS.md")
    }
}
