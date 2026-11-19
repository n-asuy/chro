import ChroDomain
import XCTest

/// The block and inline structure components/markdown.tsx renders (GFM with remark-breaks).
final class MarkdownDocumentTests: XCTestCase {
    func testParagraphsSplitOnBlankLinesAndKeepSingleBreaks() {
        let doc = MarkdownDocument.parse("Done.\nNext line\n\nSecond")
        XCTAssertEqual(doc.blocks, [
            .paragraph([.text("Done."), .lineBreak, .text("Next line")]),
            .paragraph([.text("Second")]),
        ])
    }

    func testInlineMarkup() {
        let doc = MarkdownDocument.parse("The **loop** printed `scanning sku 1` and *more*, see [docs](https://example.com).")
        XCTAssertEqual(doc.blocks, [.paragraph([
            .text("The "), .strong([.text("loop")]), .text(" printed "), .code("scanning sku 1"), .text(" and "),
            .emphasis([.text("more")]), .text(", see "), .link(text: [.text("docs")], url: "https://example.com"), .text("."),
        ])])
    }

    func testCodeSpansKeepTheirMarkersLiteral() {
        XCTAssertEqual(MarkdownDocument.parse("`a**b**` **`c`**").blocks, [.paragraph([.code("a**b**"), .text(" "), .strong([.code("c")])])])
        XCTAssertEqual(MarkdownDocument.parse("2 * 3 and a ` lone tick").blocks, [.paragraph([.text("2 * 3 and a ` lone tick")])])
    }

    func testListsHeadingsQuotesRulesAndCode() {
        let source = """
        # Title
        - **Unknown SKU** is a no-op.
        - Negative amount
          restocks.
        1. first
        2. second
        - [x] done
        > quoted
        ---
        ```ts
        const a = 1
        ```
        """
        XCTAssertEqual(MarkdownDocument.parse(source).blocks, [
            .heading(level: 1, [.text("Title")]),
            .list(ordered: false, start: 1, items: [
                .init(content: [.strong([.text("Unknown SKU")]), .text(" is a no-op.")]),
                .init(content: [.text("Negative amount"), .lineBreak, .text("restocks.")]),
            ]),
            .list(ordered: true, start: 1, items: [.init(content: [.text("first")]), .init(content: [.text("second")])]),
            .list(ordered: false, start: 1, items: [.init(content: [.text("done")], checked: true)]),
            .quote([.text("quoted")]),
            .rule,
            .code(language: "ts", text: "const a = 1"),
        ])
    }

    func testTables() {
        let doc = MarkdownDocument.parse("| SKU | Qty |\n|---|---:|\n| A1 | 5 |\n| B2 | 1 |")
        XCTAssertEqual(doc.blocks, [.table(header: [[.text("SKU")], [.text("Qty")]], rows: [[[.text("A1")], [.text("5")]], [[.text("B2")], [.text("1")]]])])
    }

    func testPlainTextDropsMarkup() {
        XCTAssertEqual(MarkdownDocument.parse("The **loop** printed `x`.\n\n- a\n- b").plainText, "The loop printed x.\n\na\nb")
    }
}
