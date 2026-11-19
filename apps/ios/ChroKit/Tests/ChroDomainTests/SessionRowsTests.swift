import Foundation
import Testing
@testable import ChroDomain

/// Port of apps/desktop/src/session/domain/__tests__/session-rows.test.ts.
func task(_ id: String, delegatedFrom: String? = nil, awaiting: Bool = false, running: Bool = false, forkedFrom: String? = nil) -> SessionSummary {
    SessionSummary(
        id: id, shortID: String(id.prefix(4)), projectID: "p1", title: id, status: "completed",
        isRunning: running, awaitingInput: awaiting, delegatedFromID: delegatedFrom, forkedFromTitle: forkedFrom,
        agent: .claudeCode, updatedAt: Date(timeIntervalSince1970: 1_780_000_000)
    )
}

private func nested(_ tasks: [SessionSummary], collapsed: Set<String> = [], rank: TreeRank = .root) -> [SessionListRow] {
    SessionRows.build(tasks, nest: true, collapsed: collapsed, rank: rank)
}

private func outline(_ rows: [SessionListRow]) -> [String] {
    rows.map { String(repeating: "  ", count: $0.depth) + $0.session.id }
}

struct SessionRowsBuildTests {
    @Test func flatListKeepsInputOrder() {
        let rows = SessionRows.build([task("a"), task("b", delegatedFrom: "a")], nest: false, collapsed: [], rank: .root)
        #expect(outline(rows) == ["a", "b"])
        #expect(rows.allSatisfy { $0.parentID == nil && $0.descendantCount == 0 })
    }

    @Test func delegatedSessionsSitUnderTheirDelegator() {
        let rows = nested([task("b", delegatedFrom: "a"), task("x"), task("a"), task("c", delegatedFrom: "a")])
        #expect(outline(rows) == ["x", "a", "  b", "  c"])
        #expect(rows[2].parentID == "a")
    }

    @Test func chainsNestBeyondOneLevel() {
        let rows = nested([task("c", delegatedFrom: "b"), task("b", delegatedFrom: "a"), task("a")])
        #expect(outline(rows) == ["a", "  b", "    c"])
        #expect(rows.map(\.descendantCount) == [2, 1, 0])
    }

    @Test func unlistedDelegatorKeepsTheRowAtTopLevel() {
        let rows = nested([task("b", delegatedFrom: "archived-parent"), task("a")])
        #expect(outline(rows) == ["b", "a"])
        #expect(rows[0].parentID == nil)
    }

    @Test func forksDoNotNest() {
        #expect(outline(nested([task("a"), task("f", forkedFrom: "a")])) == ["a", "f"])
    }

    @Test func cyclesStayAtTopLevel() {
        let rows = nested([task("a", delegatedFrom: "b"), task("b", delegatedFrom: "a"), task("c", delegatedFrom: "a"), task("self", delegatedFrom: "self")])
        #expect(outline(rows) == ["a", "  c", "b", "self"])
    }

    @Test func subtreeRankLiftsATreeToItsEarliestMember() {
        let tasks = [task("b", delegatedFrom: "a"), task("x"), task("a")]
        #expect(outline(nested(tasks, rank: .subtree)) == ["a", "  b", "x"])
        #expect(outline(nested(tasks, rank: .root)) == ["x", "a", "  b"])
    }

    @Test func collapsedRowHidesItsSubtreeAndReportsIt() {
        let rows = nested([task("a"), task("b", delegatedFrom: "a"), task("c", delegatedFrom: "b", awaiting: true)], collapsed: ["a"])
        #expect(outline(rows) == ["a"])
        #expect(rows[0].expanded == false)
        #expect(rows[0].descendantCount == 2)
        #expect(rows[0].hiddenNeedsInput)
    }

    @Test func collapseEntryOnALeafIsIgnored() {
        let rows = nested([task("a")], collapsed: ["a"])
        #expect(rows[0].expanded == false)
        #expect(rows[0].hiddenNeedsInput == false)
    }

    @Test func runningChildrenCountOnlyWhileShown() {
        let tasks = [task("a"), task("b", delegatedFrom: "a", running: true), task("c", delegatedFrom: "a")]
        #expect(nested(tasks)[0].shownRunningChildren == 1)
        #expect(nested(tasks, collapsed: ["a"])[0].shownRunningChildren == 0)
    }
}

struct SessionPreviewTests {
    private func flat(_ tasks: [SessionSummary]) -> [SessionListRow] {
        SessionRows.build(tasks, nest: false, collapsed: [], rank: .root)
    }
    private func many(_ count: Int) -> [SessionSummary] { (0..<count).map { task("t\($0)") } }
    private func ids(_ rows: [SessionListRow]) -> [String] { rows.map(\.session.id) }
    private let noneActive: (SessionSummary) -> Bool = { _ in false }

    @Test func limitIsFive() { #expect(SessionRows.previewLimit == 5) }

    @Test func shortSectionShowsInFull() {
        let preview = SessionRows.preview(flat(many(3)), isActive: noneActive)
        #expect(ids(preview.visible) == ["t0", "t1", "t2"])
        #expect(preview.hiddenCount == 0)
    }

    @Test func aSingleRowIsNeverFolded() {
        let preview = SessionRows.preview(flat(many(6)), isActive: noneActive)
        #expect(preview.visible.count == 6)
        #expect(preview.hiddenCount == 0)
    }

    @Test func longSectionFoldsToItsFirstRows() {
        let preview = SessionRows.preview(flat(many(9)), isActive: noneActive)
        #expect(ids(preview.visible) == ["t0", "t1", "t2", "t3", "t4"])
        #expect(preview.hiddenCount == 4)
    }

    @Test func focusedSessionStaysVisible() {
        let preview = SessionRows.preview(flat(many(9)), isActive: { $0.id == "t7" })
        #expect(ids(preview.visible) == ["t0", "t1", "t2", "t3", "t4", "t7"])
        #expect(preview.hiddenCount == 3)
    }

    @Test func sessionWaitingOnTheUserStaysVisible() {
        var tasks = many(9)
        tasks[8] = task("t8", awaiting: true)
        let preview = SessionRows.preview(flat(tasks), isActive: noneActive)
        #expect(ids(preview.visible) == ["t0", "t1", "t2", "t3", "t4", "t8"])
        #expect(preview.hiddenCount == 3)
    }

    @Test func showsEverythingWhenOnlyOneRowWouldFold() {
        let preview = SessionRows.preview(flat(many(7)), isActive: { $0.id == "t6" })
        #expect(preview.visible.count == 7)
        #expect(preview.hiddenCount == 0)
    }

    @Test func sessionsTheHostHasNotSentAreHiddenToo() {
        let preview = SessionRows.preview(flat(many(9)), isActive: noneActive, unheld: 3)
        #expect(ids(preview.visible) == ["t0", "t1", "t2", "t3", "t4"])
        #expect(preview.hiddenCount == 7)
    }

    @Test func oneSessionTheHostHasNotSentStillOffersShowMore() {
        // Rows the phone does not hold cannot be shown, so they fold even alone.
        let preview = SessionRows.preview(flat(many(6)), isActive: noneActive, unheld: 1)
        #expect(preview.visible.count == 6)
        #expect(preview.hiddenCount == 1)
    }

    @Test func keepsDelegatorsAboveARowKeptPastTheFold() {
        let tasks = many(6) + [task("lead"), task("mid", delegatedFrom: "lead"), task("leaf", delegatedFrom: "mid", awaiting: true), task("tail")]
        let preview = SessionRows.preview(nested(tasks), isActive: noneActive)
        #expect(ids(preview.visible) == ["t0", "t1", "t2", "t3", "t4", "lead", "mid", "leaf"])
        #expect(preview.hiddenCount == 2)
    }

    @Test func keepsACollapsedRowHidingABlockedSession() {
        let tasks = many(6) + [task("lead"), task("blocked", delegatedFrom: "lead", awaiting: true), task("tail")]
        let preview = SessionRows.preview(nested(tasks, collapsed: ["lead"]), isActive: noneActive)
        #expect(ids(preview.visible) == ["t0", "t1", "t2", "t3", "t4", "lead"])
        #expect(preview.hiddenCount == 2)
    }
}
