import ChroAPI
import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// The session list on a host that serves the window (architecture doc §27):
/// the phone holds a window of live sessions with every project's counts,
/// pages "Show more", searches and reads the archive on the host, and keeps
/// what it opened or pinned across reconnects.
@Suite(.timeLimit(.minutes(1)))
struct LiveSessionListWindowTests {
    static let project = "11111111-0000-4000-8000-000000000001"
    static let other = "33333333-0000-4000-8000-000000000003"
    let desktop = FakeDesktop()

    /// `p1-00` is the newest of 14 live sessions; `old-1`, `old-2` are archived.
    static func id(_ index: Int) -> String { String(format: "aaaa%04d-0000-4000-8000-000000000000", index) }
    static func time(_ index: Int) -> String { String(format: "2026-11-14T%02d:00:00.000Z", 23 - index) }

    init() {
        desktop.edit {
            $0.servesSessionList = true
            $0.projects = [
                FakeDesktop.project(Self.project, name: "inventory-service", path: "/Users/me/inventory-service"),
                FakeDesktop.project(Self.other, name: "pricing", path: "/Users/me/pricing"),
            ]
            for index in 0..<14 {
                $0.tasks[Self.id(index)] = FakeDesktop.task(Self.id(index), project: Self.project, title: "Session \(index)", updatedAt: Self.time(index))
            }
            for index in 20..<22 {
                $0.tasks[Self.id(index)] = FakeDesktop.task(Self.id(index), project: Self.project, title: "Archived \(index)", status: "cancelled", updatedAt: Self.time(index))
            }
            $0.tasks[Self.id(30)] = FakeDesktop.task(Self.id(30), project: Self.other, title: "Pricing needle", updatedAt: Self.time(15))
        }
    }

    private func held(_ workspace: LiveWorkspace, _ count: Int) async throws -> [SessionSummary] {
        try await eventually("\(count) sessions") { workspace.sessionList.value.count == count }
        return workspace.sessionList.value
    }

    private func windowSubscriptions() -> [FakeResponder.Subscription] {
        desktop.responders.flatMap(\.subscriptions).filter { $0.stream == FakeDesktop.sessionListStream }
    }

    @Test func theWindowHoldsEachProjectsNewestRowsAndCountsEverything() async throws {
        let phone = try desktop.phone()
        let list = try await held(phone.workspace, 11)
        #expect(list.filter { $0.projectID == Self.project }.map(\.title) == (0..<10).map { "Session \($0)" })
        try await eventually("counts") {
            phone.workspace.countState.value == [Self.project: SessionCounts(live: 14, archived: 2), Self.other: SessionCounts(live: 1, archived: 0)]
        }
        let subscription = try #require(windowSubscriptions().first)
        #expect(subscription.params == ["sort": "recent", "limit": "10"])
        #expect(!desktop.responders.flatMap(\.subscriptions).contains { $0.stream == "/streams/tasks" }, "the full task stream is not read")
        #expect(desktop.violations.isEmpty)
    }

    @Test func showMoreHoldsTheNextPageAndAReconnectKeepsIt() async throws {
        let phone = try desktop.phone()
        _ = try await held(phone.workspace, 11)
        try await phone.workspace.showMoreSessions(projectID: Self.project)
        let page = try #require(desktop.requests("GET", "/rpc/session-list").first)
        #expect(page.query == ["project_id": Self.project, "sort": "recent", "offset": "10", "limit": "50"])
        #expect(phone.workspace.sessionList.value.filter { $0.projectID == Self.project }.count == 14)

        let responder = try #require(desktop.responders.last)
        let first = try #require(windowSubscriptions().first)
        try await responder.endSubscription(first.subscriptionId)
        try await eventually("subscribed again") { windowSubscriptions().contains { $0.subscriptionId != first.subscriptionId } }
        let again = try #require(windowSubscriptions().first { $0.subscriptionId != first.subscriptionId })
        #expect(again.params["project_limits"] == "\(Self.project):60")
        try await Task.sleep(for: .milliseconds(200))
        #expect(phone.workspace.sessionList.value.filter { $0.projectID == Self.project }.count == 14)
    }

    @Test func changesOutsideTheWindowArriveAndArchivedSessionsLeave() async throws {
        let phone = try desktop.phone()
        _ = try await held(phone.workspace, 11)
        // An old session that changes is now the newest: it arrives.
        try await desktop.upsertTask(FakeDesktop.task(Self.id(13), project: Self.project, title: "Woke up", updatedAt: "2026-11-15T00:00:00.000Z"))
        try await eventually("arrived") { phone.workspace.sessionList.value.first?.title == "Woke up" }
        // Archiving a session the phone never held changes only the counts.
        try await desktop.upsertTask(FakeDesktop.task(Self.id(12), project: Self.project, title: "Session 12", status: "cancelled", updatedAt: Self.time(12)))
        try await eventually("counted") { phone.workspace.countState.value[Self.project] == SessionCounts(live: 13, archived: 3) }
        // Archiving a held one removes it.
        try await desktop.upsertTask(FakeDesktop.task(Self.id(0), project: Self.project, title: "Session 0", status: "cancelled", updatedAt: Self.time(0)))
        try await eventually("left") { !phone.workspace.sessionList.value.contains { $0.id == Self.id(0) } }
        #expect(phone.workspace.countState.value[Self.project] == SessionCounts(live: 12, archived: 4))
    }

    @Test func searchRunsOnTheHostAndOpeningAResultHoldsIt() async throws {
        let phone = try desktop.phone()
        _ = try await held(phone.workspace, 11)
        let found = try await phone.workspace.searchSessions(matching: "session 1")
        #expect(desktop.requests("GET", "/rpc/session-list").last?.query == ["q": "session 1", "limit": "200"])
        #expect(Set(found.map(\.title)) == ["Session 1", "Session 10", "Session 11", "Session 12", "Session 13"])

        let lookups = desktop.requests("GET", "/rpc/session-list").count
        await phone.workspace.holdSession(sessionID: Self.id(13))
        #expect(phone.workspace.sessionList.value.contains { $0.id == Self.id(13) })
        #expect(desktop.requests("GET", "/rpc/session-list").count == lookups, "the search result is held without asking again")

        let responder = try #require(desktop.responders.last)
        let first = try #require(windowSubscriptions().first)
        try await responder.endSubscription(first.subscriptionId)
        try await eventually("subscribed again") { windowSubscriptions().contains { $0.subscriptionId != first.subscriptionId } }
        #expect(windowSubscriptions().last?.params["include"] == Self.id(13))
    }

    @Test func aPinOutsideTheWindowIsFetched() async throws {
        let phone = try desktop.phone()
        _ = try await held(phone.workspace, 11)
        await phone.workspace.togglePin(sessionID: Self.id(12))
        try await eventually("held") { phone.workspace.sessionList.value.contains { $0.id == Self.id(12) } }
        #expect(desktop.requests("GET", "/rpc/session-list").last?.query == ["ids": Self.id(12), "limit": "200"])
    }

    @Test func aPinTheHostDoesNotHaveIsAskedForOnce() async throws {
        let archived = Self.id(20)
        desktop.edit { $0.uiState = [SessionListPreferences.Key.pins: [archived: "2026-11-14T00:00:00.000Z"]] }
        let phone = try desktop.phone()
        _ = try await held(phone.workspace, 11)
        try await eventually("subscribed with the pin") { windowSubscriptions().first?.params["include"] == archived }
        // The pin was in the window's request; later state changes do not ask again.
        await phone.workspace.markViewed(sessionID: Self.id(1))
        await phone.workspace.markViewed(sessionID: Self.id(2))
        try await Task.sleep(for: .milliseconds(200))
        #expect(desktop.requests("GET", "/rpc/session-list").isEmpty)
    }

    @Test func anotherSortAsksForAnotherWindow() async throws {
        let phone = try desktop.phone()
        _ = try await held(phone.workspace, 11)
        await phone.workspace.setSortMode(.nameAscending)
        try await eventually("new window") { windowSubscriptions().contains { $0.params["sort"] == "name-asc" } }
        try await eventually("old one released") { !windowSubscriptions().contains { $0.params["sort"] == "recent" } }
        _ = try await held(phone.workspace, 11)
    }

    @Test func theArchiveIsReadAPageAtATime() async throws {
        let phone = try desktop.phone()
        _ = try await held(phone.workspace, 11)
        let page = try await phone.workspace.archivedSessions(projectID: Self.project, matching: "21", offset: 0)
        #expect(desktop.requests("GET", "/rpc/session-list").last?.query == ["project_id": Self.project, "archived": "true", "offset": "0", "limit": "50", "q": "21"])
        #expect(page.sessions.map(\.id) == [Self.id(21)])
        #expect(page.total == 1)
    }

    @Test func aHostWithoutTheWindowCountsEveryTaskItSent() async throws {
        desktop.edit { $0.servesSessionList = false }
        let phone = try desktop.phone()
        _ = try await held(phone.workspace, 15)
        try await eventually("counts") { phone.workspace.countState.value[Self.project] == SessionCounts(live: 14, archived: 2) }
        try await phone.workspace.showMoreSessions(projectID: Self.project)
        #expect(desktop.requests("GET", "/rpc/session-list").isEmpty, "everything is already held")
        #expect(try await phone.workspace.searchSessions(matching: "needle").map(\.id) == [Self.id(30)])
        #expect(try await phone.workspace.archivedSessions(projectID: Self.project, matching: "", offset: 0).total == 2)
    }
}
