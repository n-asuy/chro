import ChroDomain
import Testing

@Suite struct FileTreeTests {
    private let entries: [FileTreeEntry] = [
        .init(path: "src", isDirectory: true), .init(path: "README.md", isDirectory: false),
        .init(path: "src/stock.ts", isDirectory: false), .init(path: "docs", isDirectory: true),
        .init(path: "docs/skus", isDirectory: true), .init(path: "docs/skus/A1.md", isDirectory: false),
        .init(path: "docs/notes.md", isDirectory: false), .init(path: "a.txt", isDirectory: false),
    ]

    @Test func rootChildrenAreFoldersFirstThenByName() {
        let rows = FileTree(entries: entries).rows(expanded: [])
        #expect(rows.map(\.path) == ["docs", "src", "a.txt", "README.md"])
        #expect(rows.allSatisfy { $0.depth == 1 })
    }

    @Test func expandedFoldersShowTheirChildrenOneLevelDeeper() {
        let rows = FileTree(entries: entries).rows(expanded: ["docs", "docs/skus"])
        #expect(rows.map(\.path) == ["docs", "docs/skus", "docs/skus/A1.md", "docs/notes.md", "src", "a.txt", "README.md"])
        #expect(rows.map(\.depth) == [1, 2, 3, 2, 1, 1, 1])
        #expect(rows[0].isExpanded && !rows[4].isExpanded)
        #expect(rows[1].name == "skus")
    }

    @Test func expandAllOpensEveryFolder() {
        #expect(FileTree(entries: entries).rows(expandAll: true).count == entries.count)
    }

    @Test func changedTreeSynthesizesParentFolders() {
        let tree = FileTree.changed(paths: ["src/stock.ts", "README.md", "src/stock.test.ts", "/src/stock.ts"])
        #expect(tree.entries.map(\.path).sorted() == ["README.md", "src", "src/stock.test.ts", "src/stock.ts"])
        #expect(tree.rows(expandAll: true).map(\.path) == ["src", "src/stock.test.ts", "src/stock.ts", "README.md"])
    }

    @Test func hiddenDirectoriesAreDroppedWithTheirContents() {
        let tree = FileTree(entries: [
            .init(path: ".claude", isDirectory: true), .init(path: ".claude/skills/x.md", isDirectory: false),
            .init(path: ".gitignore", isDirectory: false), .init(path: "src", isDirectory: true),
        ])
        #expect(tree.hidingHiddenDirectories().entries.map(\.path) == [".gitignore", "src"])
    }

    @Test func parentAndAncestors() {
        #expect(FileTree.parent(of: "docs/skus/A1.md") == "docs/skus")
        #expect(FileTree.parent(of: "README.md") == "")
        #expect(FileTree.ancestors(of: "docs/skus/A1.md") == ["docs", "docs/skus"])
    }
}

@Suite struct FileNamingTests {
    @Test func newEntriesTakeTheFirstFreeDefaultName() {
        #expect(FileNaming.newEntryName(.markdown, siblings: []) == "New file.md")
        #expect(FileNaming.newEntryName(.markdown, siblings: ["New file.md"]) == "New file 2.md")
        #expect(FileNaming.newEntryName(.markdown, siblings: ["New file.md", "New file 2.md"]) == "New file 3.md")
        #expect(FileNaming.newEntryName(.drawing, siblings: []) == "New drawing.excalidraw")
        #expect(FileNaming.newEntryName(.database, siblings: []) == "New database.cbase")
        #expect(FileNaming.newEntryName(.folder, siblings: ["New folder"]) == "New folder 2")
    }

    @Test func duplicatesAppendCopyBeforeTheExtension() {
        #expect(FileNaming.duplicateName("stock.ts", isDirectory: false, siblings: ["stock.ts"]) == "stock copy.ts")
        #expect(FileNaming.duplicateName("stock.ts", isDirectory: false, siblings: ["stock.ts", "stock copy.ts"]) == "stock copy 2.ts")
        #expect(FileNaming.duplicateName("docs", isDirectory: true, siblings: ["docs"]) == "docs copy")
        #expect(FileNaming.duplicateName(".gitignore", isDirectory: false, siblings: []) == ".gitignore copy")
    }

    @Test func initialContentPerKind() {
        #expect(FileNaming.initialContent(.markdown, directory: "") == "")
        #expect(FileNaming.initialContent(.drawing, directory: "").contains("\"type\": \"excalidraw\""))
        let base = FileNaming.initialContent(.database, directory: "docs/skus")
        #expect(base.hasPrefix("version: 1\nname: \"Untitled\"\ndataset:\n  include: [\"docs/skus/**/*.md\"]\n"))
        #expect(FileNaming.initialContent(.database, directory: "").contains("include: [\"**/*.md\"]"))
    }

    @Test func renameAcceptsOnlyANewFreeNameWithoutSlashes() {
        #expect(FileNaming.renameTarget(from: "docs/a.md", to: " b.md ", existing: []) == "docs/b.md")
        #expect(FileNaming.renameTarget(from: "a.md", to: "a.md", existing: []) == nil)
        #expect(FileNaming.renameTarget(from: "a.md", to: "  ", existing: []) == nil)
        #expect(FileNaming.renameTarget(from: "a.md", to: "x/b.md", existing: []) == nil)
        #expect(FileNaming.renameTarget(from: "a.md", to: "b.md", existing: ["b.md"]) == nil)
    }

    @Test func renameSelectsTheNameBeforeTheExtension() {
        #expect(FileNaming.renameSelection("stock.test.ts", isDirectory: false) == 0..<10)
        #expect(FileNaming.renameSelection("Makefile", isDirectory: false) == 0..<8)
        #expect(FileNaming.renameSelection("v1.2", isDirectory: true) == 0..<4)
        #expect(FileNaming.renameSelection(".env", isDirectory: false) == 0..<4)
    }

    @Test func moveOffersEveryOtherFolderAndTheRoot() {
        let folders = ["docs", "docs/skus", "src", "src/lib"]
        let all = FileNaming.moveDestinations(moving: "src", folders: folders, query: "")
        #expect(all == ["", "docs", "docs/skus"])
        #expect(FileNaming.moveDestinations(moving: "README.md", folders: folders, query: "SK") == ["docs/skus"])
        #expect(FileNaming.moveDestinations(moving: "README.md", folders: folders, query: "root") == [""])
        #expect(FileNaming.moveTarget(moving: "src/stock.ts", into: "docs") == "docs/stock.ts")
        #expect(FileNaming.moveTarget(moving: "src/stock.ts", into: "") == "stock.ts")
    }

    @Test func movedPathsRewriteDescendants() {
        #expect(FileNaming.relocate("src/lib/a.ts", from: "src", to: "code") == "code/lib/a.ts")
        #expect(FileNaming.relocate("src", from: "src", to: "code") == "code")
        #expect(FileNaming.relocate("srcx/a.ts", from: "src", to: "code") == "srcx/a.ts")
    }

    @Test func deletePromptsFollowTheDesktop() {
        #expect(FileNaming.deleteTitle(name: "README.md") == "Delete README.md?")
        #expect(FileNaming.deleteMessage(isDirectory: false) == "This action cannot be undone. This will permanently delete the file.")
        #expect(FileNaming.deleteMessage(isDirectory: true) == "This action cannot be undone. This will permanently delete the folder and all its contents.")
    }
}

@Suite struct DirectoryAgentTests {
    @Test func briefIsAgentsThenClaudeInsideTheDirectory() {
        let files: Set<String> = ["CLAUDE.md", "apps/desktop/AGENTS.md", "apps/desktop/CLAUDE.md"]
        #expect(DirectoryBrief.find(in: "apps/desktop", files: files) == "apps/desktop/AGENTS.md")
        #expect(DirectoryBrief.find(in: "", files: files) == "CLAUDE.md")
        #expect(DirectoryBrief.find(in: "apps", files: files) == nil)
    }

    @Test func inheritedBriefIsTheNearestAncestors() {
        let files: Set<String> = ["CLAUDE.md", "apps/AGENTS.md"]
        #expect(DirectoryBrief.inherited(by: "apps/desktop/src", files: files) == "apps/AGENTS.md")
        #expect(DirectoryBrief.inherited(by: "docs", files: files) == "CLAUDE.md")
        #expect(DirectoryBrief.inherited(by: "", files: files) == nil)
    }

    @Test func crumbsStartWithTheProjectName() {
        #expect(DirectoryBrief.crumbs(projectName: "inventory-service", path: "docs/skus") == ["inventory-service", "docs", "skus"])
        #expect(DirectoryBrief.crumbs(projectName: "inventory-service", path: "") == ["inventory-service"])
    }

    @Test func outcomesLabelTheLedger() {
        #expect(LedgerOutcome.allCases.map(\.label) == ["Merged", "Completed", "Failed", "Archived"])
        #expect(LedgerOutcome(status: "completed", merged: false) == .completed)
        #expect(LedgerOutcome(status: "completed", merged: true) == .merged)
        #expect(LedgerOutcome(status: "failed", merged: false) == .failed)
        #expect(LedgerOutcome(status: "cancelled", merged: false) == .archived)
        #expect(LedgerOutcome(status: "in_progress", merged: false) == nil)
    }
}
