import ChroDomain
import XCTest

/// conversation-fork-origin.tsx
final class ContinuationOriginTests: XCTestCase {
    func testInlinesRunsUpToTheAnchorAtMostFive() {
        let runs = (1...8).map { "r\($0)" }
        XCTAssertEqual(ContinuationOrigin.inlinedRuns(ascending: runs, anchorRunID: "r3"), ["r1", "r2", "r3"])
        XCTAssertEqual(ContinuationOrigin.inlinedRuns(ascending: runs, anchorRunID: "r7"), ["r3", "r4", "r5", "r6", "r7"])
        XCTAssertEqual(ContinuationOrigin.inlinedRuns(ascending: runs, anchorRunID: nil), ["r4", "r5", "r6", "r7", "r8"])
        XCTAssertEqual(ContinuationOrigin.inlinedRuns(ascending: runs, anchorRunID: "gone"), ["r4", "r5", "r6", "r7", "r8"])
    }

    func testInheritedEntriesAreMarked() {
        let entries = [
            ConversationEntry(id: "a:0", runID: "a", kind: .userMessage("one")),
            ConversationEntry(id: "a:1", runID: "a", kind: .assistantMessage("ok")),
            ConversationEntry(id: "b:0", runID: "b", kind: .userMessage("two")),
        ]
        let inherited = ContinuationOrigin.inheritedEntries(entries, anchorRunID: "a")
        XCTAssertEqual(inherited.map(\.id), ["a:0", "a:1"])
        XCTAssertTrue(inherited.allSatisfy(\.isInherited))
    }

    func testLinkTitle() {
        XCTAssertEqual(ContinuationOrigin(sourceSessionID: "s", sourceTitle: nil, history: .native([])).linkTitle, "Continued from task")
        XCTAssertEqual(ContinuationOrigin(sourceSessionID: "s", sourceTitle: nil, history: .digest(user: "u", assistant: nil)).linkTitle,
                       "Continued from task (summary)")
    }
}
