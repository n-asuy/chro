import XCTest

/// The right dock's Search files panel on the fixture services.
@MainActor
final class DockSearchUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard", "-ChroScreen", "dock-search"]
        app.launch()
    }

    private var field: XCUIElement { app.textFields["Search…"].firstMatch }
    private func button(_ label: String) -> XCUIElement { SettledElement.wait(app.buttons[label].firstMatch) }
    private func text(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    func testFocusShowsTheOptionsAndAnOperatorInserts() {
        XCTAssertTrue(text("Type to search.").waitForExistence(timeout: 5))
        field.tap()
        XCTAssertTrue(text("Search options").waitForExistence(timeout: 2))
        button("tag: match #tag").tap()
        XCTAssertEqual(field.value as? String, "tag:")
    }

    func testContentResultsGroupByFileAndCollapse() {
        field.tap()
        field.typeText("addStock")
        XCTAssertTrue(text("2 files · 2 matches").waitForExistence(timeout: 5))
        XCTAssertTrue(button("Collapse all").exists)
        button("Collapse all").tap()
        XCTAssertTrue(button("Expand all").waitForExistence(timeout: 2))
    }

    func testSortOrderPicks() {
        field.tap()
        field.typeText("stock\n")
        XCTAssertTrue(button("Sort order").waitForExistence(timeout: 5))
        // Line numbers repeat across files; every file keeps all of its lines.
        XCTAssertTrue(app.buttons["docs/restock-notes.md line 9: - [x] Draft the low-stock list"].waitForExistence(timeout: 2))
        button("Sort order").tap()
        button("Path (Z to A)").tap()
        XCTAssertEqual(button("Sort order").value as? String, "Path (Z to A)")
    }

    func testFileOperatorCompletesAndListsNameMatches() {
        field.tap()
        field.typeText("file:sto")
        XCTAssertTrue(button("stock.ts").waitForExistence(timeout: 3))
        button("stock.ts").tap()
        XCTAssertEqual(field.value as? String, "file:stock.ts")
        field.typeText("\n")
        XCTAssertTrue(text("1 file · 0 matches").waitForExistence(timeout: 5))
    }

    func testOpeningAResultClosesTheDockAndRemembersTheQuery() {
        field.tap()
        field.typeText("reorder_point\n")
        let line = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "docs/stock-levels.csv line 1")).firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 5))
        line.tap()
        XCTAssertFalse(field.waitForExistence(timeout: 2), "the dock closes for the pushed file")
        app.terminate()
        app.launch()
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        XCTAssertTrue(button("reorder_point").waitForExistence(timeout: 3), "the query is in the history")
        // The options list runs under the keyboard: drag its visible top part, not its centre (a flick on the
        // kana keyboard types a character, which hides the history), nor the screen behind the dock.
        let options = app.scrollViews["search-options"]
        options.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
            .press(forDuration: 0.05, thenDragTo: options.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.02)))
        button("Clear history").tap()
        XCTAssertFalse(button("reorder_point").waitForExistence(timeout: 1))
    }

    func testNoMatchesHint() {
        field.tap()
        field.typeText("zzzz-not-there")
        XCTAssertTrue(text("No matches found.").waitForExistence(timeout: 5))
    }
}
