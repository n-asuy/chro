import XCTest

/// The shell's links into the right dock: a revealed path, New session here,
/// no dock for chats outside a project, and path links in a conversation.
@MainActor
final class DockLinksUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func launch(_ screen: String, focus: String? = nil) {
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard", "-ChroScreen", screen] + (focus.map { ["-ChroFocus", $0] } ?? [])
        app.launch()
    }

    private func row(_ name: String) -> XCUIElement { app.descendants(matching: .any)["tree:\(name)"].firstMatch }
    private func button(_ label: String) -> XCUIElement { SettledElement.wait(app.buttons[label].firstMatch) }

    func testRevealPathExpandsToTheFolderAndNewSessionHereMentionsIt() {
        launch("agent-directory")
        let skus = row("skus")
        XCTAssertTrue(skus.waitForExistence(timeout: 5), "docs is expanded down to skus")
        XCTAssertTrue(skus.isSelected)
        skus.tap()
        button("Agent").tap()
        button("New session here").tap()
        XCTAssertTrue(app.staticTexts["New session"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Remove @skus"].waitForExistence(timeout: 3), "the composer starts with the folder mentioned")
    }

    func testAChatOutsideAProjectHasNoRightPanel() {
        launch("new-chat")
        XCTAssertTrue(app.staticTexts["New session"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Open right panel"].exists)
        XCTAssertFalse(app.buttons["Open Source Control"].exists)
    }

    func testAProjectSessionKeepsItsRightPanel() {
        launch("home")
        XCTAssertTrue(button("Open right panel").waitForExistence(timeout: 5))
    }

    func testAToolRowPathOpensTheFile() {
        launch("session", focus: "b41c8e33-rev")
        // The step group is summarised by the path; expanding it shows the Read row.
        let group = button("src/stock.ts")
        XCTAssertTrue(group.waitForExistence(timeout: 6))
        group.tap()
        let link = app.buttons["path-link:src/stock.ts"].firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 6), "the Read row's path resolves to a link")
        link.tap()
        XCTAssertTrue(app.staticTexts["stock.ts"].waitForExistence(timeout: 5), "the file screen is pushed")
    }

    func testAnInlineCodePathOpensTheFile() {
        launch("session", focus: "bd50a1e2-img")
        let link = app.links["docs/images/stock-trend.svg"].firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 6), "the code span resolves to a link")
        XCTAssertFalse(app.links["zlib"].exists, "a span that names nothing stays plain")
        for _ in 0..<4 where !link.isHittable { app.swipeDown() }
        link.tap()
        XCTAssertTrue(app.staticTexts["stock-trend.svg"].waitForExistence(timeout: 5), "the file screen is pushed")
    }
}
