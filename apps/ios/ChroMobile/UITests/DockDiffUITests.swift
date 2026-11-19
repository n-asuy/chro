import XCTest

/// The run diff pushed from the dock (mock slot 9) and its route error page (slot 24).
@MainActor
final class DockDiffUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func launch(_ screen: String) {
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard", "-ChroScreen", screen]
        app.launch()
    }

    private func element(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func button(_ label: String) -> XCUIElement { SettledElement.wait(app.buttons[label].firstMatch) }

    /// The Expand / Collapse button of a file's card.
    private func toggle(_ path: String) -> XCUIElement {
        SettledElement.wait(app.buttons.matching(NSPredicate(format: "value == %@", path)).firstMatch)
    }

    /// The launch opens the diff focused on src/stock.ts, as slot 9: that card is expanded, the others collapsed.
    func testTotalsAndTheFocusedCard() {
        launch("diff")
        XCTAssertTrue(element("3 files changed").waitForExistence(timeout: 5))
        XCTAssertTrue(element("+35").exists)
        XCTAssertTrue(element("@@ -3,3 +3,10 @@").waitForExistence(timeout: 2))
        XCTAssertTrue(button("Collapse All").exists)
        XCTAssertTrue(button("Open src/stock.ts").exists)
        XCTAssertFalse(element("- `removeStock(items, sku, amount)` subtracts, never below 0.").exists, "README.md stays collapsed")
    }

    func testTogglingACodeFileAndSplitView() {
        launch("diff")
        XCTAssertTrue(element("@@ -3,3 +3,10 @@").waitForExistence(timeout: 5))
        toggle("src/stock.ts").tap()
        XCTAssertFalse(element("@@ -3,3 +3,10 @@").waitForExistence(timeout: 1))
        XCTAssertTrue(button("Expand All").exists)
        toggle("src/stock.ts").tap()
        XCTAssertTrue(element("@@ -3,3 +3,10 @@").waitForExistence(timeout: 2))
        attachScreenshot("diff-unified-expanded")
        XCTAssertTrue(element("Added: export function removeStock(items: Item[], sku: string, amount: number): Item[] {").exists)
        button("Split").tap()
        XCTAssertTrue(button("Split").isSelected)
        attachScreenshot("diff-split-expanded")
        button("Collapse All").tap()
        XCTAssertFalse(element("@@ -3,3 +3,10 @@").waitForExistence(timeout: 1))
    }

    func testExpandAllShowsTheProseDocument() {
        launch("diff")
        XCTAssertTrue(button("Collapse All").waitForExistence(timeout: 5))
        button("Collapse All").tap()
        button("Expand All").tap()
        XCTAssertTrue(element("- `removeStock(items, sku, amount)` subtracts, never below 0.").waitForExistence(timeout: 2))
        attachScreenshot("diff-expand-all")
    }

    func testCloseReturnsToWhereTheDiffWasOpened() {
        launch("diff")
        XCTAssertTrue(button("Close Diff").waitForExistence(timeout: 5))
        button("Close Diff").tap()
        XCTAssertFalse(element("3 files changed").waitForExistence(timeout: 1))
    }

    func testFailedLoadShowsTheErrorPage() {
        launch("error-page")
        XCTAssertTrue(element("Something went wrong").waitForExistence(timeout: 5))
        XCTAssertTrue(button("Retry").exists)
        button("Retry").tap()
        XCTAssertTrue(element("If this keeps happening, reload the view or go back to the start.").waitForExistence(timeout: 3))
        button("Go to start").tap()
        XCTAssertFalse(element("Something went wrong").waitForExistence(timeout: 1))
    }

    /// Kept in the result bundle for the screenshot comparison with the mock.
    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
