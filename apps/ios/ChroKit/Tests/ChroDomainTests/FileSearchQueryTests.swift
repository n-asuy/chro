import ChroDomain
import Testing

/// The content-search grammar, checked against the server's own cases
/// (file-search-cache `query.rs`).
@Suite struct FileSearchQueryTests {
    private func lines(_ query: String, _ name: String, _ content: String) -> [Int]? {
        let compiled = try! FileSearchQuery(query)
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init).filter { !$0.isEmpty }
        return compiled.evaluate(name: name, lines: lines).map { $0.keys.sorted() }
    }

    @Test func implicitAndRequiresAllTerms() {
        #expect(lines("foo bar", "a.txt", "foo here\nbar there\n") != nil)
        #expect(lines("foo baz", "a.txt", "foo here\nbar there\n") == nil)
    }

    @Test func orMatchesEither() {
        #expect(lines("foo OR baz", "a.txt", "only baz\n") != nil)
        #expect(lines("qux OR baz", "a.txt", "nothing\n") == nil)
    }

    @Test func negationExcludes() {
        #expect(lines("foo -bar", "a.txt", "foo alone\n") != nil)
        #expect(lines("foo -bar", "a.txt", "foo and bar\n") == nil)
    }

    @Test func groupingControlsPrecedence() {
        #expect(lines("foo (bar OR baz)", "a.txt", "foo\nbaz\n") != nil)
        #expect(lines("foo (bar OR baz)", "a.txt", "foo only\n") == nil)
    }

    @Test func exactPhraseIsLiteral() {
        #expect(lines("\"foo bar\"", "a.txt", "foo bar baz\n") != nil)
        #expect(lines("\"foo bar\"", "a.txt", "foo then bar\n") == nil)
    }

    @Test func regexTerm() {
        #expect(lines("/\\d{4}-\\d{2}/", "a.txt", "date 2026-07 today\n") != nil)
        #expect(lines("/\\d{4}-\\d{2}/", "a.txt", "no digits\n") == nil)
    }

    @Test func invalidRegexIsAnError() {
        #expect(throws: FileSearchQuery.InvalidQuery.self) { try FileSearchQuery("/(/") }
    }

    @Test func fileAndPathFieldsDoNotReadContent() throws {
        let file = try FileSearchQuery("file:report")
        #expect(!file.readsContent)
        #expect(file.evaluate(name: "dir/report.md", lines: []) != nil)
        #expect(file.evaluate(name: "dir/other.md", lines: []) == nil)
        let path = try FileSearchQuery("path:dir/")
        #expect(path.evaluate(name: "dir/report.md", lines: []) != nil)
        #expect(path.evaluate(name: "elsewhere/report.md", lines: []) == nil)
    }

    @Test func fileTermCombinesWithContentTerm() throws {
        let query = try FileSearchQuery("file:a.md hello")
        #expect(query.readsContent)
        #expect(query.evaluate(name: "a.md", lines: ["say hello"]) != nil)
        #expect(query.evaluate(name: "b.md", lines: ["say hello"]) == nil)
        #expect(query.evaluate(name: "a.md", lines: ["no greeting"]) == nil)
    }

    @Test func lineScopeRequiresSameLine() {
        #expect(lines("line:(foo bar)", "a.txt", "foo and bar together\n") != nil)
        #expect(lines("line:(foo bar)", "a.txt", "foo up here\nbar down there\n") == nil)
        #expect(lines("line:foo", "a.txt", "x\nfoo\n") == [2])
    }

    @Test func tagMatchesHashPrefixedWord() {
        #expect(lines("tag:#work", "a.txt", "todo #work item\n") != nil)
        #expect(lines("tag:work", "a.txt", "todo #work item\n") != nil)
        #expect(lines("tag:work", "a.txt", "plain work\n") == nil)
    }

    @Test func smartCaseAndOverrides() throws {
        #expect(lines("needle", "a.txt", "NEEDLE\n") != nil)
        #expect(lines("Needle", "a.txt", "needle\n") == nil)
        #expect(lines("match-case:needle", "a.txt", "NEEDLE\n") == nil)
        #expect(lines("ignore-case:Needle", "a.txt", "needle\n") != nil)
        // The panel's Match case toggle forces every term sensitive.
        let forced = try FileSearchQuery("needle", caseSensitive: true)
        #expect(forced.evaluate(name: "a.txt", lines: ["NEEDLE"]) == nil)
    }

    @Test func highlightsCoverAllPositiveTerms() throws {
        let highlights = try #require(try FileSearchQuery("foo bar").evaluate(name: "a.txt", lines: ["foo here", "bar there", "foo and bar"]))
        #expect(highlights.keys.sorted() == [1, 2, 3])
        #expect(highlights[3] == [0..<3, 8..<11])
    }

    @Test func highlightRangesAreUTF16Offsets() throws {
        let highlights = try #require(try FileSearchQuery("stock").evaluate(name: "a.md", lines: ["日本 stock"]))
        #expect(highlights[1] == [3..<8])
    }

    @Test func blankQueryIsEmpty() throws {
        #expect(try FileSearchQuery("   ").isEmpty)
        #expect(try !FileSearchQuery("x").isEmpty)
    }

    @Test func nameMatchRanksTheBasename() throws {
        let query = try FileSearchQuery("stock")
        #expect(query.matchesName("src/stock.ts"))
        #expect(!query.matchesName("README.md"))
    }
}
