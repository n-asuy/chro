import Foundation
import Testing
@testable import ChroDomain

/// Ports of task-read-state.ts (leading marker) and session-subline.ts.
struct SessionRowRulesTests {
    let updated = Date(timeIntervalSince1970: 1_800_000_000)

    func fields(running: Bool = false, status: String = "completed", worktreeDeleted: Bool = false) -> MarkerFields {
        MarkerFields(isRunning: running, status: status, worktreeDeleted: worktreeDeleted, updatedAt: updated)
    }

    @Test func runningSessionsShowNoMarker() {
        #expect(StatusMarker.derive(fields(running: true), lastViewedAt: nil) == nil)
    }

    @Test func cleanedWorktreeWinsOverReadState() {
        #expect(StatusMarker.derive(fields(worktreeDeleted: true), lastViewedAt: nil) == .cleaned)
    }

    @Test func onlyTerminalStatusesCanBeUnread() {
        #expect(StatusMarker.derive(fields(status: "in_progress"), lastViewedAt: nil) == nil)
        #expect(StatusMarker.derive(fields(status: "cancelled"), lastViewedAt: nil) == nil)
    }

    @Test func unreadCompletedAndFailed() {
        #expect(StatusMarker.derive(fields(status: "completed"), lastViewedAt: nil) == .completedUnread)
        #expect(StatusMarker.derive(fields(status: "failed"), lastViewedAt: updated.addingTimeInterval(-1)) == .failedUnread)
    }

    @Test func viewingAtOrAfterTheUpdateClearsTheMarker() {
        #expect(StatusMarker.derive(fields(), lastViewedAt: updated) == nil)
        #expect(StatusMarker.derive(fields(), lastViewedAt: updated.addingTimeInterval(5)) == nil)
    }

    func input(note: String? = nil, summary: String? = nil, forkedFrom: String? = nil, delegatedFrom: String? = nil) -> SublineInput {
        SublineInput(note: note, summary: summary, forkedFromTitle: forkedFrom, delegatedFromTitle: delegatedFrom)
    }

    @Test func runningNoteBeatsSummary() {
        #expect(Subline.derive(input(note: "running tests", summary: "done"), isRunning: true, showProject: false, projectName: nil, nestedUnderDelegator: false) == .note("running tests"))
        #expect(Subline.derive(input(note: "running tests", summary: "done"), isRunning: false, showProject: false, projectName: nil, nestedUnderDelegator: false) == .summary("done"))
    }

    @Test func provenanceThenProject() {
        #expect(Subline.derive(input(forkedFrom: "A"), isRunning: false, showProject: true, projectName: "p", nestedUnderDelegator: false) == .forked("A"))
        #expect(Subline.derive(input(delegatedFrom: "B"), isRunning: false, showProject: true, projectName: "p", nestedUnderDelegator: true) == .project("p"))
        #expect(Subline.derive(input(delegatedFrom: "B"), isRunning: false, showProject: false, projectName: nil, nestedUnderDelegator: false) == .delegated("B"))
        #expect(Subline.derive(input(), isRunning: false, showProject: false, projectName: "p", nestedUnderDelegator: false) == nil)
    }

    @Test func displayedTextUsesTheDesktopStrings() {
        #expect(Subline.forked("A").text == "Continued from A")
        #expect(Subline.delegated("B").text == "Delegated from B")
        #expect(Subline.project("p").text == "p")
    }
}
