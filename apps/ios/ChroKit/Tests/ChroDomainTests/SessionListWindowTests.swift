import Testing
@testable import ChroDomain

struct SessionListWindowTests {
    @Test func aFreshWindowAsksForTheDefaultRowsInTheListsOrder() {
        #expect(SessionListWindow(sortMode: .nameDescending).params(pinned: []) == ["sort": "name-desc", "limit": "10"])
    }

    @Test func showMoreAsksForTheNextPageAndKeepsItAcrossReconnects() {
        var window = SessionListWindow()
        let first = window.nextPage(of: "p1")
        #expect(first.offset == 10 && first.limit == SessionListWindow.pageSize)
        window.extend("p1", through: first)
        #expect(window.limit(for: "p1") == 60)
        #expect(window.nextPage(of: "p1").offset == 60)
        #expect(window.limit(for: "p2") == 10)
        #expect(window.params(pinned: [])["project_limits"] == "p1:60")
    }

    @Test func pinnedAndHeldSessionsAreIncludedOnce() {
        var window = SessionListWindow()
        window.hold("opened")
        window.hold("pin-b")
        window.hold("opened")
        #expect(window.params(pinned: ["pin-b", "pin-a"])["include"] == "pin-a,pin-b,opened")
    }

    @Test func theOldestHeldSessionsLeaveFirst() {
        var window = SessionListWindow()
        for index in 0...SessionListWindow.maxIncluded { window.hold("s\(index)") }
        #expect(window.held.count == SessionListWindow.maxIncluded)
        #expect(window.held.first == "s1")
    }
}
