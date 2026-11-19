import ChroDomain
import Testing

@Suite struct DiffHunksTests {
    @Test func trailingNewlineIsNotALine() {
        #expect(DiffText.lines("a\nb\n") == ["a", "b"])
        #expect(DiffText.lines("a\nb") == ["a", "b"])
        #expect(DiffText.lines("") == [])
        #expect(DiffText.lines("\n") == [""])
    }

    @Test func appendedFunctionMakesOneHunkWithThreeLinesOfContext() {
        let old = "l1\nl2\nl3\nl4\nl5\n"
        let new = "l1\nl2\nl3\nl4\nl5\nn6\nn7\n"
        let hunks = DiffHunks.build(old: old, new: new)
        #expect(hunks.count == 1)
        #expect(hunks[0].header == "@@ -3,3 +3,5 @@")
        #expect(hunks[0].lines == [
            .init(kind: .context, oldNumber: 3, newNumber: 3, text: "l3"),
            .init(kind: .context, oldNumber: 4, newNumber: 4, text: "l4"),
            .init(kind: .context, oldNumber: 5, newNumber: 5, text: "l5"),
            .init(kind: .added, oldNumber: nil, newNumber: 6, text: "n6"),
            .init(kind: .added, oldNumber: nil, newNumber: 7, text: "n7"),
        ])
    }

    @Test func distantChangesMakeSeparateHunks() {
        let old = (1...20).map { "l\($0)" }.joined(separator: "\n")
        var lines = (1...20).map { "l\($0)" }
        lines[1] = "x2"
        lines[18] = "x19"
        let hunks = DiffHunks.build(old: old, new: lines.joined(separator: "\n"))
        #expect(hunks.count == 2)
        #expect(hunks[0].header == "@@ -1,5 +1,5 @@")
        #expect(hunks[1].header == "@@ -16,5 +16,5 @@")
    }

    @Test func newFileHunkStartsAtZero() {
        let hunks = DiffHunks.build(old: "", new: "a\nb\n")
        #expect(hunks.map(\.header) == ["@@ -0,0 +1,2 @@"])
    }

    @Test func deletedFileHunkEndsAtZero() {
        #expect(DiffHunks.build(old: "a\n", new: "").map(\.header) == ["@@ -1,1 +0,0 @@"])
    }

    @Test func identicalContentHasNoHunks() {
        #expect(DiffHunks.build(old: "a\n", new: "a\n").isEmpty)
    }

    @Test func statsCountChangedLines() {
        let stats = DiffHunks.stats(old: "a\nb\n", new: "a\nc\nd\n")
        #expect(stats.additions == 2 && stats.deletions == 1)
    }

    @Test func documentKeepsEveryLineWithDeletionsInPlace() {
        let rows = DiffHunks.document(old: "a\nold\nc\n", new: "a\nnew\nc\n")
        #expect(rows.map(\.kind) == [.context, .added, .removed, .context])
        #expect(rows.map(\.text) == ["a", "new", "old", "c"])
    }

    @Test func proseAndImagePaths() {
        #expect(DiffText.isProse("README.md") && DiffText.isProse("notes.MDX") && !DiffText.isProse("a.ts"))
        #expect(DiffText.isImage("docs/a.PNG") && DiffText.isImage("b.svg") && !DiffText.isImage("c.pdf"))
    }
}
