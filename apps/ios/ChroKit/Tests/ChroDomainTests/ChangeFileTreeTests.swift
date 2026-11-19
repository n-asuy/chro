import ChroDomain
import Testing

@Suite struct ChangeFileTreeTests {
    @Test func listModeKeepsTheGivenOrderAtDepthZero() {
        let rows = ChangeFileTree.rows(paths: ["b.ts", "a/x.ts"], mode: .list, collapsed: [])
        #expect(rows == [.file(path: "b.ts", depth: 0), .file(path: "a/x.ts", depth: 0)])
    }

    @Test func treePutsFoldersFirstAndSortsByName() {
        let rows = ChangeFileTree.rows(paths: ["README.md", "src/stock.ts", "src/stock.test.ts"], mode: .tree, collapsed: [])
        #expect(rows == [
            .directory(key: "src", name: "src", depth: 0, isCollapsed: false),
            .file(path: "src/stock.test.ts", depth: 1),
            .file(path: "src/stock.ts", depth: 1),
            .file(path: "README.md", depth: 0),
        ])
    }

    @Test func singleChildFolderChainsAreCompactedUnderTheDeepestKey() {
        let rows = ChangeFileTree.rows(paths: ["docs/images/a.png", "docs/images/b.svg"], mode: .tree, collapsed: [])
        #expect(rows.first == .directory(key: "docs/images", name: "docs/images", depth: 0, isCollapsed: false))
        #expect(rows.count == 3)
    }

    @Test func collapsedFoldersHideTheirChildren() {
        let rows = ChangeFileTree.rows(paths: ["src/a.ts", "z.md"], mode: .tree, collapsed: ["src"])
        #expect(rows == [.directory(key: "src", name: "src", depth: 0, isCollapsed: true), .file(path: "z.md", depth: 0)])
    }

    @Test func pagesThreeHundredFilesAtATime() {
        let paths = (0..<650).map { "f\($0).ts" }
        #expect(ChangeFileTree.visibleCount(total: 650, pages: 1) == 300)
        #expect(ChangeFileTree.moreLabel(total: paths.count, visible: 300) == "Show 300 more (350 remaining)")
        #expect(ChangeFileTree.moreLabel(total: 650, visible: 600) == "Show 50 more (50 remaining)")
        #expect(ChangeFileTree.moreLabel(total: 650, visible: 650) == nil)
    }

    @Test func fileNameIsTheLastSegment() {
        #expect(ChangeFileTree.fileName("src/stock.ts") == "stock.ts")
        #expect(ChangeFileTree.fileName("") == "(unknown)")
        #expect(ChangeFileTree.fileName("dir/") == "dir/")
    }
}
