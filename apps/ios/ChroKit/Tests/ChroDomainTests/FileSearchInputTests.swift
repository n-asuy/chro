import ChroDomain
import Testing

/// The Search panel's input rules (search-panel.tsx) and the server's snippet trimming.
@Suite struct FileSearchInputTests {
    @Test func trailingOperatorIsDetectedOnlyAtTheEnd() {
        #expect(FileSearchInput.trailingOperator("path:") == .init(field: .path, partial: "", start: 0))
        #expect(FileSearchInput.trailingOperator("foo file:sto") == .init(field: .file, partial: "sto", start: 4))
        #expect(FileSearchInput.trailingOperator("(path:src") == .init(field: .path, partial: "src", start: 1))
        #expect(FileSearchInput.trailingOperator("path:src foo") == nil)
        #expect(FileSearchInput.trailingOperator("content:x") == nil)
    }

    @Test func completingReplacesThePartial() {
        let active = FileSearchInput.trailingOperator("foo file:sto")!
        #expect(FileSearchInput.complete("foo file:sto", operator: active, with: "stock.ts") == "foo file:stock.ts")
    }

    @Test func insertingAnOperatorAddsASpaceWhenNeeded() {
        #expect(FileSearchInput.insert("path:", into: "") == "path:")
        #expect(FileSearchInput.insert("path:", into: "foo") == "foo path:")
        #expect(FileSearchInput.insert("tag:", into: "foo ") == "foo tag:")
    }

    @Test func optionRowsMatchTheDesktop() {
        #expect(FileSearchInput.options.map(\.token) == ["path:", "file:", "content:", "tag:", "line:(…)", "match-case:", "\"…\"", "/…/", "a OR b   -c"])
        #expect(FileSearchInput.options.filter { $0.insert != nil }.map(\.token) == ["path:", "file:", "content:", "tag:", "match-case:"])
    }

    @Test func plainNeedlesDropOperatorsAndExclusions() {
        #expect(FileSearchInput.plainNeedles("\"Foo Bar\" file:stock -tmp OR /x+/ tag:#todo (deep)") == ["foo bar", "stock", "todo", "deep"])
    }

    @Test func needleRangesAreMergedAndCaseInsensitive() {
        #expect(FileSearchInput.needleRanges(in: "src/stock.ts", needles: ["stock", "ock.t"]) == [4..<11])
        #expect(FileSearchInput.needleRanges(in: "README.md", needles: ["read"]) == [0..<4])
        #expect(FileSearchInput.needleRanges(in: "x", needles: []).isEmpty)
    }

    @Test func pathSuggestionsIncludeMatchingAncestors() {
        let hits = [("src/stock.ts", true), ("src/stock.test.ts", true), ("docs/skus/A1.md", true)]
        #expect(FileSearchInput.suggestions(.path, partial: "s", from: hits) == ["src", "docs", "docs/skus", "src/stock.ts", "docs/skus/A1.md", "src/stock.test.ts"])
        #expect(FileSearchInput.suggestions(.file, partial: "stock", from: hits) == ["stock.ts", "stock.test.ts"])
    }

    @Test func historyIsMostRecentFirstDedupedAndCapped() {
        var history: [String] = []
        for query in ["a", "b", "a", "  ", "c"] { history = FileSearchInput.pushHistory(query, onto: history) }
        #expect(history == ["c", "a", "b"])
        for index in 0..<20 { history = FileSearchInput.pushHistory("q\(index)", onto: history) }
        #expect(history.count == 10)
        #expect(history.first == "q19")
    }

    @Test func summaryLineCountsFilesAndMatches() {
        #expect(FileSearchInput.summary(files: 1, matches: 1, shown: 1, truncated: false) == "1 file · 1 match")
        #expect(FileSearchInput.summary(files: 3, matches: 9, shown: 3, truncated: false) == "3 files · 9 matches")
        #expect(FileSearchInput.summary(files: 500, matches: 900, shown: 50, truncated: true) == "500+ files · 900 matches · top 50")
    }

    @Test func sortLabelsAreTheDesktopOnes() {
        #expect(FileSearchSort.allCases.map(\.label) == ["Relevance", "Modified (new to old)", "Modified (old to new)", "File name (A to Z)",
                                                         "File name (Z to A)", "Path (A to Z)", "Path (Z to A)"])
        #expect(FileSearchSort.modifiedDescending.rawValue == "modified-desc")
    }

    @Test func snippetTrimsLeadingSpaceAndShiftsRanges() {
        let snippet = FileSearchSnippet.make(line: "    return stock;", ranges: [11..<16])
        #expect(snippet.text == "return stock;")
        #expect(snippet.ranges == [7..<12])
    }

    @Test func longLinesAreWindowedAroundTheFirstMatch() {
        let line = String(repeating: "a", count: 300) + "needle" + String(repeating: "b", count: 300)
        let snippet = FileSearchSnippet.make(line: line, ranges: [300..<306])
        #expect(snippet.text.hasPrefix("…"))
        #expect(snippet.text.hasSuffix("…"))
        #expect(snippet.text.utf16.count == 240 + 2)
        #expect(snippet.ranges == [33..<39])
    }
}
