import ChroDomain
import XCTest

/// session/types/context.ts parseContextFromContent / formatContextForPrompt and the prompt assembly of single-agent-session.tsx.
final class PromptContentTests: XCTestCase {
    func testPlainTextHasNoAttachments() {
        let parsed = PromptContent.parse("Summarize src/stock.ts in one sentence.")
        XCTAssertEqual(parsed.text, "Summarize src/stock.ts in one sentence.")
        XCTAssertEqual(parsed.attachments, [])
    }

    func testContextSkillsAndImagesBecomePillsInOrder() {
        let content = """
        <context>
        <file path="src/stock.ts" />
        <directory path="docs" branch="main" />
        <past_session task_id="7a3f5d10-add">
        Referenced session. A summary is injected at execution time; run `chro session read 7a3f5d10-add --format markdown` for the full transcript.
        </past_session>
        </context>
        <skills_context>
        <skill id="chro" name="chro" />
        </skills_context>
        ![shelf-photo.png](/uploads/shelf-photo.png)
        What colors are in this photo?
        """
        let parsed = PromptContent.parse(content)
        XCTAssertEqual(parsed.text, "What colors are in this photo?")
        XCTAssertEqual(parsed.attachments, [
            .file(path: "src/stock.ts", isDirectory: false),
            .file(path: "docs", isDirectory: true),
            .session(taskID: "7a3f5d10-add"),
            .skill(name: "chro"),
            .image(name: "shelf-photo.png", path: "/uploads/shelf-photo.png"),
        ])
    }

    func testXmlAttributesAreUnescaped() {
        let parsed = PromptContent.parse("<context>\n<file path=\"a &amp; b &quot;c&quot;.md\" />\n</context>\n\nRead it")
        XCTAssertEqual(parsed.attachments, [.file(path: "a & b \"c\".md", isDirectory: false)])
        XCTAssertEqual(parsed.text, "Read it")
    }

    func testPageAnnotationsAreCounted() {
        let content = """
        <context>
        <page_annotations path="docs/index.html" viewport="390x844">
        Comments the user pinned on elements of the rendered page.
        <annotation n="1" selector="h1" rect="0,0,10,10">
        <element>h1</element>
        <comment>Bigger</comment>
        </annotation>
        <annotation n="2" selector="p" rect="0,20,10,10">
        <element>p</element>
        <comment>Shorter</comment>
        </annotation>
        </page_annotations>
        </context>
        Apply the notes
        """
        XCTAssertEqual(PromptContent.parse(content).attachments, [.annotations(path: "docs/index.html", noteCount: 2)])
    }

    func testMarkupNotAtTheStartStaysText() {
        let parsed = PromptContent.parse("Explain <context>\n<file path=\"a\" />\n</context>")
        XCTAssertEqual(parsed.attachments, [])
        XCTAssertTrue(parsed.text.hasPrefix("Explain"))
    }

    func testFormatJoinsContextSkillsImagesAndText() {
        let prompt = PromptContent.format(
            text: "  Ship it  ",
            references: [
                .init(kind: .file, path: "src/a.ts"),
                .init(kind: .directory, path: "docs"),
                .init(kind: .session, path: "t-1"),
                .init(kind: .skill, path: "chro"),
            ],
            images: [.init(name: "a.png", path: "/up/a.png")]
        )
        XCTAssertEqual(prompt, """
        <context>
        <file path="src/a.ts" />
        <directory path="docs" />
        <past_session task_id="t-1">
        Referenced session. A summary is injected at execution time; run `chro session read t-1 --format markdown` for the full transcript.
        </past_session>
        </context>
        <skills_context>
        <skill id="chro" name="chro" />
        </skills_context>
        ![a.png](/up/a.png)
        Ship it
        """)
        // The round trip gives the same pills back.
        XCTAssertEqual(PromptContent.parse(prompt).attachments.count, 5)
        XCTAssertEqual(PromptContent.parse(prompt).text, "Ship it")
    }

    func testFormatOfTextAloneIsTheText() {
        XCTAssertEqual(PromptContent.format(text: "hi", references: [], images: []), "hi")
        XCTAssertEqual(PromptContent.format(text: "  ", references: [], images: []), "")
    }

    func testAttachmentLabels() {
        XCTAssertEqual(PromptAttachment.file(path: "src/stock.ts", isDirectory: false).label, "stock.ts")
        XCTAssertEqual(PromptAttachment.skill(name: "chro").label, "chro")
        XCTAssertEqual(PromptAttachment.image(name: "shelf-photo.png", path: "/x").label, "shelf-photo.png")
        XCTAssertEqual(PromptAttachment.annotations(path: "docs/index.html", noteCount: 2).label, "2 notes on index.html")
    }
}
