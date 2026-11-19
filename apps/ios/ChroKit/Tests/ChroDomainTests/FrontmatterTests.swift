import ChroDomain
import Testing

@Suite struct FrontmatterTests {
    static let notes = ["---", "owner: warehouse", "reviewed: false", "tags: [restock]", "---", "# Restock notes", "", "- [ ] Confirm"]

    @Test func parsesTypedPropertiesAndBody() {
        let doc = Frontmatter.parse(Self.notes)
        #expect(doc.properties.map(\.key) == ["owner", "reviewed", "tags"])
        #expect(doc.properties[0].value == .text("warehouse"))
        #expect(doc.properties[1].value == .checkbox(false))
        #expect(doc.properties[2].value == .tags(["restock"]))
        #expect(doc.bodyStart == 5)
        #expect(doc.hasBlock)
    }

    @Test func numbersDatesAndQuotedText() {
        let doc = Frontmatter.parse(["---", "on_hand: 5", "ratio: 0.5", "due: 2026-11-14", "name: \"a: b\"", "empty:", "---"])
        #expect(doc.properties.map(\.value) == [.number(5), .number(0.5), .date("2026-11-14"), .text("a: b"), .text("")])
        #expect(doc.properties.map(\.value.type) == [.number, .number, .date, .text, .text])
    }

    @Test func blockListsAndNestedValuesSurvive() {
        let lines = ["---", "tags:", "  - a", "  - b", "meta:", "  owner: x", "---", "body"]
        let doc = Frontmatter.parse(lines)
        #expect(doc.properties[0].value == .tags(["a", "b"]))
        #expect(doc.properties[1].value == .nested("owner: x"))
        // Rewriting without changes keeps the bytes.
        #expect(Frontmatter.write(doc.properties, into: lines) == lines)
    }

    @Test func noBlockMeansNoProperties() {
        let doc = Frontmatter.parse(["# Title", "---"])
        #expect(doc.properties.isEmpty)
        #expect(doc.bodyStart == 0)
        #expect(!doc.hasBlock)
    }

    @Test func writingChangesOnlyTheBlock() {
        var props = Frontmatter.parse(Self.notes).properties
        props[1].value = .checkbox(true)
        props[2].value = .tags(["restock", "urgent"])
        let written = Frontmatter.write(props, into: Self.notes)
        #expect(written == ["---", "owner: warehouse", "reviewed: true", "tags: [restock, urgent]", "---", "# Restock notes", "", "- [ ] Confirm"])
    }

    @Test func addingToANoteWithoutBlockCreatesOneAndRemovingTheLastDropsIt() {
        let added = Frontmatter.write([FrontmatterProperty(key: "status", value: .text(""))], into: ["# A1"])
        #expect(added == ["---", "status: ", "---", "# A1"])
        #expect(Frontmatter.write([], into: added) == ["# A1"])
    }

    @Test func textThatWouldReadAsAnotherTypeIsQuoted() {
        let written = Frontmatter.write([
            FrontmatterProperty(key: "a", value: .text("true")),
            FrontmatterProperty(key: "b", value: .text("12")),
            FrontmatterProperty(key: "c", value: .text("x: y")),
            FrontmatterProperty(key: "d", value: .number(4)),
            FrontmatterProperty(key: "e", value: .tags([])),
        ], into: [])
        #expect(written == ["---", "a: \"true\"", "b: \"12\"", "c: \"x: y\"", "d: 4", "e: []", "---"])
    }

    @Test(arguments: [
        (FrontmatterValue.tags(["a", "b"]), FrontmatterValue.Kind.text, FrontmatterValue.text("a, b")),
        (.text("7"), .number, .number(7)),
        (.text("abc"), .number, .number(0)),
        (.text("false"), .checkbox, .checkbox(false)),
        (.text("yes"), .checkbox, .checkbox(true)),
        (.text(""), .checkbox, .checkbox(false)),
        (.text("2026-01-02"), .date, .date("2026-01-02")),
        (.text("soon"), .date, .date("2026-11-14")),
        (.text(""), .tags, .tags([])),
        (.text("x"), .tags, .tags(["x"])),
        (.number(3), .text, .text("3")),
    ])
    func convertsBetweenTypes(from: FrontmatterValue, to kind: FrontmatterValue.Kind, expected: FrontmatterValue) {
        #expect(from.converted(to: kind, today: "2026-11-14") == expected)
    }
}
