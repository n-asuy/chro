import ChroDomain
import Testing

/// session/components/file-path-utils.ts and the server's path_link.rs position split.
@Suite struct PathLinkTests {
    @Test func shapeTestRejectsWhatCannotNameAPath() {
        for text in ["useState", "npm run build --watch --silent --force", "https://chro-ai.com/docs", "git commit -m \"x\"",
                     "#tag", "/", "//", "", "   ", "a\tb", "a`b", "<div>"] {
            #expect(!PathLinkShape.looksLikeFilePath(text), "\(text)")
        }
    }

    @Test func shapeTestKeepsPathsAndFileNames() {
        for text in ["src/stock.ts", "README.md", "stock.ts:12", "stock.ts:12:5", "/private/tmp/a", "docs/My Notes/a b.md", "~/notes/report.html"] {
            #expect(PathLinkShape.looksLikeFilePath(text), "\(text)")
        }
        // Four spaces are prose, not a name.
        #expect(!PathLinkShape.looksLikeFilePath("a b c d e/f"))
        #expect(!PathLinkShape.looksLikeFilePath(String(repeating: "a/", count: 257)))
    }

    @Test func splitsTrailingLineAndColumnOnly() {
        #expect(PathLinkShape.splitPosition("src/main.rs:12:5") == .init(path: "src/main.rs", line: 12, column: 5))
        #expect(PathLinkShape.splitPosition("src/main.rs:12") == .init(path: "src/main.rs", line: 12, column: nil))
        #expect(PathLinkShape.splitPosition("C:/src/main.rs") == .init(path: "C:/src/main.rs", line: nil, column: nil))
        #expect(PathLinkShape.splitPosition("note:draft") == .init(path: "note:draft", line: nil, column: nil))
        #expect(PathLinkShape.splitPosition(":12") == .init(path: ":12", line: nil, column: nil))
    }

    @Test func aHitUnderAKnownRootOpensThatCheckout() {
        let hit = PathProbeResult(exists: true, kind: .file, absolutePath: "/w/run/src/a.ts", root: "/w/run", relativePath: "src/a.ts", line: 3)
        #expect(hit.relative(toAnyOf: ["/w/main", "/w/run"]) == .init(rootIndex: 1, path: "src/a.ts"))
        // A trailing slash on the root does not matter.
        #expect(hit.relative(toAnyOf: ["/w/run/"]) == .init(rootIndex: 0, path: "src/a.ts"))
    }

    @Test func missesAndPathsOutsideEveryRootAreNotLinks() {
        #expect(PathProbeResult(exists: false).relative(toAnyOf: ["/w"]) == nil)
        let outside = PathProbeResult(exists: true, kind: .file, absolutePath: "/Users/me/notes.md")
        #expect(outside.relative(toAnyOf: ["/w"]) == nil)
        // Without a root from the server, the absolute path decides.
        let bare = PathProbeResult(exists: true, kind: .directory, absolutePath: "/w/docs")
        #expect(bare.relative(toAnyOf: ["/w"]) == .init(rootIndex: 0, path: "docs"))
    }
}
