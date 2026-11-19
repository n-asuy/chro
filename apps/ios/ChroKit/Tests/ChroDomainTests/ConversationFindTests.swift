import ChroDomain
import XCTest

/// conversation-find-highlighter.ts and find-bar.tsx
final class ConversationFindTests: XCTestCase {
    func testMatchesAreCaseInsensitiveAndPerTextNode() {
        let entries = [
            ConversationEntry(id: "r:0", runID: "r", kind: .userMessage("<context>\n<file path=\"batch.ts\" />\n</context>\nRun the Batch loop")),
            ConversationEntry(id: "r:1", runID: "r", kind: .toolUse(ToolUse(toolName: "Bash", action: .commandRun(command: "echo batch", result: nil), status: .success))),
            ConversationEntry(id: "r:2", runID: "r", kind: .assistantMessage("All **batches** printed (`reconcile batch 1`).\n\n- batch")),
            ConversationEntry(id: "r:3", runID: "r", kind: .errorMessage("batch failed", .other)),
        ]
        XCTAssertEqual(ConversationFind.matches(query: " batch ", in: entries), [
            .init(entryID: "r:0", localIndex: 0),
            .init(entryID: "r:2", localIndex: 0), .init(entryID: "r:2", localIndex: 1), .init(entryID: "r:2", localIndex: 2),
            .init(entryID: "r:3", localIndex: 0),
        ])
        XCTAssertEqual(ConversationFind.matches(query: "  ", in: entries), [])
        XCTAssertEqual(ConversationFind.matches(query: "printed (", in: entries), [.init(entryID: "r:2", localIndex: 0)])
        XCTAssertEqual(ConversationFind.matches(query: "s pr", in: entries), [], "a match never spans text nodes")
    }

    func testCounterAndStepping() {
        XCTAssertEqual(ConversationFind.counter(current: 0, total: 0), "0/0")
        XCTAssertEqual(ConversationFind.counter(current: 2, total: 5), "3/5")
        XCTAssertEqual(ConversationFind.step(0, by: -1, total: 5), 4)
        XCTAssertEqual(ConversationFind.step(4, by: 1, total: 5), 0)
        XCTAssertEqual(ConversationFind.step(3, by: 1, total: 0), 0)
    }
}
