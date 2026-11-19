import ChroDomain
import Testing

@Suite struct ProseMarkdownTests {
    @Test func classifiesBlocks() {
        #expect(ProseBlock(line: "# Restock notes") == .heading(level: 1, text: "Restock notes"))
        #expect(ProseBlock(line: "### Deep") == .heading(level: 3, text: "Deep"))
        #expect(ProseBlock(line: "- [ ] Confirm") == .task(checked: false, text: "Confirm"))
        #expect(ProseBlock(line: "- [x] Draft") == .task(checked: true, text: "Draft"))
        #expect(ProseBlock(line: "- [X] Draft") == .task(checked: true, text: "Draft"))
        #expect(ProseBlock(line: "* item") == .bullet(text: "item"))
        #expect(ProseBlock(line: "2. second") == .ordered(number: 2, text: "second"))
        #expect(ProseBlock(line: "#hashtag") == .paragraph(text: "#hashtag"))
        #expect(ProseBlock(line: "") == .paragraph(text: ""))
    }

    @Test func inlineSpans() {
        let spans = ProseInline.parse("Use `x` and **bold**, *it*, ~~gone~~, ==mark==, [[README]], [form](https://a.b) or https://example.com/reorder-form")
        #expect(spans == [
            .text("Use "), .code("x"), .text(" and "), .bold("bold"), .text(", "), .italic("it"), .text(", "),
            .strike("gone"), .text(", "), .highlight("mark"), .text(", "), .wikilink(target: "README", label: "README"),
            .text(", "), .link(label: "form", url: "https://a.b"), .text(" or "), .url("https://example.com/reorder-form"),
        ])
    }

    @Test func wikilinkWithAlias() {
        #expect(ProseInline.parse("[[docs/a|A]]") == [.wikilink(target: "docs/a", label: "A")])
    }

    @Test func enterContinuesListsAndTasks() {
        #expect(ProseEditing.split(lines: ["- [x] done item"], line: 0, offset: 15) == .init(lines: ["- [x] done item", "- [ ] "], line: 1, offset: 6))
        #expect(ProseEditing.split(lines: ["- abc"], line: 0, offset: 3) == .init(lines: ["- a", "- bc"], line: 1, offset: 2))
        #expect(ProseEditing.split(lines: ["3. x"], line: 0, offset: 4) == .init(lines: ["3. x", "4. "], line: 1, offset: 3))
        #expect(ProseEditing.split(lines: ["plain"], line: 0, offset: 2) == .init(lines: ["pl", "ain"], line: 1, offset: 0))
    }

    @Test func enterOnAnEmptyItemEndsTheList() {
        #expect(ProseEditing.split(lines: ["- a", "- "], line: 1, offset: 2) == .init(lines: ["- a", ""], line: 1, offset: 0))
    }

    @Test func backspaceAtStartJoinsWithThePreviousLine() {
        #expect(ProseEditing.join(lines: ["ab", "cd"], line: 1) == .init(lines: ["abcd"], line: 0, offset: 2))
    }

    @Test func togglesTasks() {
        #expect(ProseEditing.toggleTask("- [ ] a") == "- [x] a")
        #expect(ProseEditing.toggleTask("- [x] a") == "- [ ] a")
        #expect(ProseEditing.toggleTask("plain") == "plain")
    }

    @Test func formattingWrapsTheSelection() {
        #expect(ProseEditing.wrap("hello world", selection: 6..<11, marker: "**") == .init(text: "hello **world**", selection: 8..<13))
        #expect(ProseEditing.wrap("ab", selection: 1..<1, marker: "`") == .init(text: "a``b", selection: 2..<2))
        #expect(ProseEditing.link("see docs", selection: 4..<8) == .init(text: "see [docs](https://)", selection: 11..<19))
    }
}

@Suite struct FindInTextTests {
    @Test func caseInsensitiveMatchesInOrder() {
        let matches = FindInText.matches(of: "stock", in: ["Stock helpers", "restock(stock)"])
        #expect(matches == [.init(line: 0, range: 0..<5), .init(line: 1, range: 2..<7), .init(line: 1, range: 8..<13)])
        #expect(FindInText.matches(of: "", in: ["a"]).isEmpty)
    }

    @Test func stepWrapsBothWays() {
        #expect(FindInText.step(0, by: -1, count: 3) == 2)
        #expect(FindInText.step(2, by: 1, count: 3) == 0)
        #expect(FindInText.step(0, by: 1, count: 0) == 0)
        #expect(FindInText.counter(index: 1, count: 3, query: "a") == "2/3")
        #expect(FindInText.counter(index: 0, count: 0, query: "a") == "0/0")
        #expect(FindInText.counter(index: 0, count: 0, query: "") == "")
    }
}

@Suite struct ViewerZoomTests {
    @Test func imageZoomStepsAndBounds() {
        #expect(ViewerZoom.image.zoomIn(1) == 1.25)
        #expect(ViewerZoom.image.zoomOut(1) == 0.8)
        #expect(ViewerZoom.image.zoomIn(7.9) == 8)
        #expect(ViewerZoom.image.zoomOut(0.26) == 0.25)
        #expect(!ViewerZoom.image.canZoomIn(8))
        #expect(!ViewerZoom.image.canZoomOut(0.25))
        #expect(ViewerZoom.percent(1.25) == "125%")
    }

    @Test func pdfZoomIsLinear() {
        #expect(ViewerZoom.pdf.zoomIn(1) == 1.25)
        #expect(ViewerZoom.pdf.zoomOut(0.5) == 0.5)
        #expect(ViewerZoom.pdf.zoomIn(3) == 3)
    }

    @Test func rotationCycles() {
        #expect(ViewerZoom.rotated(270) == 0)
        #expect(ViewerZoom.rotated(0) == 90)
    }

    @Test func fitScaleKeepsSmallImagesAtNaturalSize() {
        #expect(ViewerZoom.fitScale(width: 64, height: 64, into: CGSizeValue(width: 326, height: 560)) == 1)
        #expect(ViewerZoom.fitScale(width: 652, height: 100, into: CGSizeValue(width: 326, height: 560)) == 0.5)
    }
}
