import ChroDomain
import Testing

@Suite struct ChangeBaseTests {
    @Test func resolvesFromTheScopesDiff() {
        let entries = [ChangeBase.Entry(path: "src/stock.ts", oldContent: "a\n", isComparable: true),
                       ChangeBase.Entry(path: "logo.png", oldContent: nil, isComparable: false)]
        #expect(ChangeBase.resolve(path: "/src/stock.ts", entries: entries) == .changed(base: "a\n"))
        #expect(ChangeBase.resolve(path: "logo.png", entries: entries) == .unavailable)
        #expect(ChangeBase.resolve(path: "README.md", entries: entries) == .unchanged)
        #expect(ChangeBase.resolve(path: "README.md", entries: nil) == .unknown)
        #expect(ChangeBase.resolve(path: "new.ts", entries: [ChangeBase.Entry(path: "new.ts", oldContent: nil, isComparable: true)]) == .changed(base: ""))
    }

    @Test func theBaseTextOfAnUnchangedFileIsTheDiskText() {
        #expect(ChangeBase.changed(base: "x").text(disk: "y") == "x")
        #expect(ChangeBase.unchanged.text(disk: "y") == "y")
        #expect(ChangeBase.unknown.text(disk: "y") == nil)
        #expect(ChangeBase.unavailable.text(disk: "y") == nil)
    }

    @Test func changedLinesAreTheAddedOrEditedLinesOfTheCurrentText() {
        #expect(ChangeBase.changedLines(base: "a\nb\n", text: "a\nB\nc\n") == [2, 3])
        #expect(ChangeBase.changedLines(base: nil, text: "a") == [])
    }

    @Test func aTrailingNewlineEndsTheLastLineAsInGit() {
        // src/stock.ts of the first capture: a blank line and a function appended (lines 6-12).
        let base = "1\n2\n3\n4\n}\n"
        let text = "1\n2\n3\n4\n}\n\nf\na\nb\nc\nd\n}\n"
        #expect(ChangeBase.changedLines(base: base, text: text) == Set(6...12))
    }
}
