import ChroDomain
import XCTest

/// session/lib/session-queue.ts
final class SessionQueueRulesTests: XCTestCase {
    private let prompt = "<context>\n<file path=\"src/a.ts\" />\n</context>\n<skills_context>\n<skill id=\"chro\" name=\"chro\" />\n</skills_context>\n![a.png](/up/a.png)\nShip it"

    func testPreviewCountsWhatTravelsWithTheText() {
        XCTAssertEqual(QueueRules.preview(prompt), QueueRules.Preview(text: "Ship it", images: 1, references: 1, skills: 1))
        XCTAssertEqual(QueueRules.preview("plain"), QueueRules.Preview(text: "plain", images: 0, references: 0, skills: 0))
    }

    func testEditingReplacesOnlyTheWrittenText() {
        XCTAssertEqual(QueueRules.split(prompt).text, "Ship it")
        XCTAssertEqual(QueueRules.rewrite(prompt, text: "Ship it today"), prompt.replacingOccurrences(of: "Ship it", with: "Ship it today"))
        XCTAssertEqual(QueueRules.rewrite("plain", text: "new"), "new")
        XCTAssertEqual(QueueRules.split("Explain <context>\n<file path=\"a\" />\n</context>").prefix, "", "markup inside the text is all text")
    }

    func testMove() {
        XCTAssertEqual(QueueRules.move(["a", "b", "c"], from: "c", to: "a"), ["c", "a", "b"])
        XCTAssertEqual(QueueRules.move(["a", "b", "c"], from: "a", to: "c"), ["b", "c", "a"])
        XCTAssertEqual(QueueRules.move(["a", "b"], from: "a", to: "a"), ["a", "b"])
        XCTAssertEqual(QueueRules.move(["a", "b"], from: "x", to: "a"), ["a", "b"])
    }

    func testSubmitIntent() {
        XCTAssertEqual(QueueRules.submitIntent(turnInFlight: false, waiting: 0), .send)
        XCTAssertEqual(QueueRules.submitIntent(turnInFlight: true, waiting: 0), .queue)
        XCTAssertEqual(QueueRules.submitIntent(turnInFlight: false, waiting: 2), .queue, "earlier messages go first")
        XCTAssertEqual(QueueRules.headline(count: 3), "3 in queue")
    }
}
