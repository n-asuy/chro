import ChroDomain
import Testing

@Suite struct LineDiffTests {
    @Test func identicalTextIsAllContext() {
        let ops = LineDiff.compute(old: ["a", "b"], new: ["a", "b"])
        #expect(ops == [.context(old: 1, new: 1), .context(old: 2, new: 2)])
        #expect(LineDiff.changedNewLines(old: ["a", "b"], new: ["a", "b"]).isEmpty)
    }

    @Test func appendedLinesAreAdded() {
        let ops = LineDiff.compute(old: ["a"], new: ["a", "b", "c"])
        #expect(ops == [.context(old: 1, new: 1), .added(new: 2), .added(new: 3)])
    }

    @Test func replacedLineIsRemovedThenAdded() {
        // The mock's lineDiff: on a tie the addition comes first.
        let ops = LineDiff.compute(old: ["x", "old", "z"], new: ["x", "new", "z"])
        #expect(ops == [.context(old: 1, new: 1), .added(new: 2), .removed(old: 2), .context(old: 3, new: 3)])
        #expect(LineDiff.changedNewLines(old: ["x", "old", "z"], new: ["x", "new", "z"]) == [2])
    }

    @Test func emptyOldMakesEveryLineAdded() {
        #expect(LineDiff.compute(old: [], new: ["a", "b"]) == [.added(new: 1), .added(new: 2)])
        #expect(LineDiff.compute(old: ["a"], new: []) == [.removed(old: 1)])
    }

    @Test func countsMatchTheCapturedStats() {
        // src/stock.ts of the first capture: +7 -0 against the merge base.
        let base = ["a", "b", "c", "d", "e", ""]
        let head = ["a", "b", "c", "d", "e", "", "f1", "f2", "f3", "f4", "f5", "f6", ""]
        let stats = LineDiff.stats(old: base, new: head)
        #expect(stats.additions == 7)
        #expect(stats.deletions == 0)
    }

    @Test func splitsTextIntoLines() {
        #expect(LineDiff.lines("a\nb\n") == ["a", "b", ""])
        #expect(LineDiff.lines("") == [])
    }
}
