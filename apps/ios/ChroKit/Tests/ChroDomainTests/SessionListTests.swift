import Foundation
import Testing
@testable import ChroDomain

private let base = Date(timeIntervalSince1970: 1_780_000_000)

private func s(_ id: String, title: String?? = .none, project: String = "p1", status: String = "completed", awaiting: Bool = false,
               running: Bool = false, delegatedFrom: String? = nil, minutesAgo: Double = 0) -> SessionSummary {
    SessionSummary(id: id, shortID: id, projectID: project, title: title ?? id, status: status, isRunning: running,
                   awaitingInput: awaiting, delegatedFromID: delegatedFrom, agent: .claudeCode,
                   updatedAt: base.addingTimeInterval(-minutesAgo * 60))
}

/// session-grouping.ts deriveSessionState.
struct SessionRunStateTests {
    @Test func awaitingWinsOverRunning() {
        #expect(SessionRunState(s("a", awaiting: true, running: true)) == .needsInput)
        #expect(SessionRunState(s("a", status: "failed", running: true)) == .running)
    }

    @Test func storedStatusMapsWhenIdle() {
        #expect(SessionRunState(s("a", status: "completed")) == .completed)
        #expect(SessionRunState(s("a", status: "failed")) == .failed)
        #expect(SessionRunState(s("a", status: "cancelled")) == .cancelled)
        #expect(SessionRunState(s("a", status: "in_progress")) == .running)
        #expect(SessionRunState(s("a", status: "pending")) == .pending)
        #expect(SessionRunState(s("a", status: "something-new")) == .pending)
    }
}

/// session-grouping.ts sortPinnedSessions.
struct PinnedOrderTests {
    @Test func urgentPinsFloatThenMostRecentlyPinnedFirst() {
        let pins = ["old": base, "new": base.addingTimeInterval(60), "failed": base.addingTimeInterval(-60), "blocked": base.addingTimeInterval(-120)]
        let sorted = PinnedSessions.sorted([s("old"), s("failed", status: "failed"), s("new"), s("blocked", awaiting: true, running: true)], pins: pins)
        #expect(sorted.map(\.id) == ["blocked", "failed", "new", "old"])
    }

    @Test func missingPinTimeSortsLast() {
        let sorted = PinnedSessions.sorted([s("none"), s("dated")], pins: ["dated": base])
        #expect(sorted.map(\.id) == ["dated", "none"])
    }
}

/// projects-panel.tsx sortTasks and orderedProjects.
struct SessionListOrderTests {
    @Test func recentOrdersByUpdatedAtDescending() {
        let sorted = SessionListOrder.sortSessions([s("old", minutesAgo: 10), s("new", minutesAgo: 1)], mode: .recent)
        #expect(sorted.map(\.id) == ["new", "old"])
    }

    @Test func nameModesOrderByTitle() {
        let list = [s("b", title: "Bravo"), s("a", title: "alpha"), s("c", title: .some(nil))]
        #expect(SessionListOrder.sortSessions(list, mode: .nameAscending).map(\.id) == ["c", "a", "b"])
        #expect(SessionListOrder.sortSessions(list, mode: .nameDescending).map(\.id) == ["b", "a", "c"])
    }

    @Test func projectsUnderRecentFollowLatestActivityThenName() {
        let projects = [ProjectSummary(id: "z", name: "zeta", path: "/z"), ProjectSummary(id: "a", name: "alpha", path: "/a"), ProjectSummary(id: "m", name: "mid", path: "/m")]
        let sessions = [s("1", project: "m", minutesAgo: 1), s("2", project: "z", minutesAgo: 5)]
        #expect(SessionListOrder.orderProjects(projects, sessions: sessions, mode: .recent).map(\.id) == ["m", "z", "a"])
        #expect(SessionListOrder.orderProjects(projects, sessions: sessions, mode: .nameAscending).map(\.id) == ["a", "m", "z"])
        #expect(SessionListOrder.orderProjects(projects, sessions: sessions, mode: .nameDescending).map(\.id) == ["z", "m", "a"])
    }

    @Test func sortModeLabelsAndWireValues() {
        #expect(SessionSortMode.allCases.map(\.rawValue) == ["recent", "name-asc", "name-desc"])
        #expect(SessionSortMode.allCases.map(\.label) == ["Recent activity", "Name (A→Z)", "Name (Z→A)"])
        #expect(SessionSortMode.recent.treeRank == .subtree)
        #expect(SessionSortMode.nameAscending.treeRank == .root)
    }
}

struct SessionListLayoutTests {
    let inventory = ProjectSummary(id: "inv", name: "inventory-service", path: "/inv")
    let other = ProjectSummary(id: "other", name: "other", path: "/other")

    func layout(_ sessions: [SessionSummary], pins: [String: Date] = [:], sort: SessionSortMode = .recent, nest: Bool = true,
                collapsed: Set<String> = [], open: [ProjectSummary]? = nil) -> SessionListLayout {
        SessionListLayout(sessions: sessions, openProjects: open ?? [inventory, other], scratchProjectIDs: ["general"],
                          pins: pins, sortMode: sort, nestDelegations: nest, collapsedDelegations: collapsed)
    }

    @Test func pinnedSessionsLeaveTheirProjectGroup() {
        let l = layout([s("a", project: "inv"), s("b", project: "inv", minutesAgo: 1)], pins: ["b": base])
        #expect(l.pinned.map(\.session.id) == ["b"])
        #expect(l.projects.first { $0.project.id == "inv" }?.rows.map(\.session.id) == ["a"])
    }

    @Test func scratchSessionsGoToChats() {
        let l = layout([s("c", project: "general"), s("a", project: "inv")])
        #expect(l.chats.map(\.session.id) == ["c"])
        #expect(l.projects.flatMap(\.rows).map(\.session.id) == ["a"])
    }

    @Test func sessionsOfClosedProjectsFallAway() {
        let l = layout([s("x", project: "closed"), s("a", project: "inv")])
        #expect(l.projects.flatMap(\.rows).map(\.session.id) == ["a"])
        #expect(l.pinned.isEmpty && l.chats.isEmpty)
    }

    @Test func emptyOpenProjectsStillRender() {
        let l = layout([s("a", project: "inv")])
        #expect(l.projects.map(\.project.id) == ["inv", "other"])
        #expect(l.projects[1].rows.isEmpty)
    }

    @Test func delegationNestsInsideTheProjectGroup() {
        let l = layout([s("add", project: "inv", minutesAgo: 8), s("rev", project: "inv", delegatedFrom: "add", minutesAgo: 8)])
        let rows = l.projects[0].rows
        #expect(rows.map(\.depth) == [0, 1])
        #expect(rows[0].descendantCount == 1)
    }

    @Test func pinnedRowsAreFlat() {
        let l = layout([s("add", project: "inv"), s("rev", project: "inv", delegatedFrom: "add")], pins: ["add": base, "rev": base])
        #expect(l.pinned.allSatisfy { $0.depth == 0 })
    }

    @Test func countsForCollapsedHeaders() {
        let l = layout([s("c", project: "general"), s("a", project: "inv")], pins: ["a": base])
        #expect(l.count(of: .pinned) == 1)
        #expect(l.count(of: .projects) == 2)
        #expect(l.count(of: .chats) == 1)
    }
}

/// The left panel's connector: the focused session and the sessions it delegated to or from.
struct RelatedSessionsTests {
    @Test func focusAndItsDelegationNeighbours() {
        let list = [s("add"), s("rev", delegatedFrom: "add"), s("other"), s("deep", delegatedFrom: "rev")]
        #expect(RelatedSessions.ids(focus: "add", in: list) == ["add", "rev"])
        #expect(RelatedSessions.ids(focus: "rev", in: list) == ["add", "rev", "deep"])
    }

    @Test func aLoneSessionHasNoConnector() {
        #expect(RelatedSessions.ids(focus: "other", in: [s("other"), s("add")]).isEmpty)
        #expect(RelatedSessions.ids(focus: nil, in: [s("other")]).isEmpty)
    }
}

struct SessionSummaryTests {
    @Test func displayTitleFallsBackToTheDesktopString() {
        #expect(s("a", title: .some(nil)).displayTitle == "Unconfirmed Session")
        #expect(s("a", title: "").displayTitle == "Unconfirmed Session")
        #expect(s("a", title: "Hi").displayTitle == "Hi")
    }

    @Test func markerReadsTheWatermark() {
        let done = s("a", status: "completed")
        #expect(done.marker(lastViewedAt: nil) == .completedUnread)
        #expect(done.marker(lastViewedAt: base) == nil)
    }

    @Test func agentNames() {
        #expect(AgentKind.allCases.map(\.displayName) == ["Claude Code", "Codex", "pi"])
        #expect(AgentKind.allCases.map(\.rawValue) == ["CLAUDE_CODE", "CODEX", "PI"])
    }
}
