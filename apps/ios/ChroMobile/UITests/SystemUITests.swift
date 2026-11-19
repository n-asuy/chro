import XCTest

/// Agent status, Feedback and Release notes on the fixture services.
@MainActor
final class SystemUITests: XCTestCase {
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

    func testAgentStatusShowsServerAndAgents() {
        launch("agent-status")
        XCTAssertTrue(element("server 0.1.57").waitForExistence(timeout: 5))
        XCTAssertTrue(element("2.1.323 (Claude Code)").exists)
        XCTAssertTrue(app.buttons["Claude Code install guide"].exists)
        XCTAssertTrue(app.buttons["chro releases"].exists)
        XCTAssertTrue(element("latest: v0.1.57").exists)
    }

    func testAgentStatusShowsUsageOnlyForAgentsWithTokensInTheWindow() {
        launch("agent-status")
        // Claude Code reported tokens in the window; Codex keeps no logs and pi had none.
        XCTAssertTrue(element("45.0k out · 83% cached · 3 sessions · $1.23").waitForExistence(timeout: 5))
        XCTAssertTrue(element("1.2M").exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "% cached · 0 sessions")).count, 0)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "5h")).count, 1)
    }

    func testAgentStatusRefreshShowsTheNewProbe() {
        launch("agent-status")
        XCTAssertTrue(element("latest: v0.1.57").waitForExistence(timeout: 5))
        button("Refresh").tap()
        // The second probe finds v0.1.58 published.
        XCTAssertTrue(element("latest: v0.1.58").waitForExistence(timeout: 5))
        XCTAssertFalse(element("latest: v0.1.57").exists)
    }

    func testCopyingTheInstallCommandPutsItOnTheClipboard() {
        launch("agent-status")
        let copy = app.buttons["Copy command"].firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 5))
        XCTAssertFalse(copy.isSelected)
        XCTAssertEqual(copy.value as? String, "npm install -g @chro-ai/cli")
        // Reading the string would raise the paste-permission prompt; these checks do not.
        let pasteboard = UIPasteboard.general
        pasteboard.items = []
        let before = pasteboard.changeCount
        XCTAssertFalse(pasteboard.hasStrings)
        copy.tap()
        XCTAssertTrue(copy.wait(for: \.isSelected, toEqual: true, timeout: 2))
        XCTAssertGreaterThan(pasteboard.changeCount, before)
        XCTAssertTrue(pasteboard.hasStrings)
    }

    func testFeedbackSendsAndThanks() {
        launch("feedback")
        XCTAssertTrue(button("Report a bug").waitForExistence(timeout: 5))
        XCTAssertTrue(element("Follow on X").exists)
        button("Report a bug").tap()
        let send = button("Send")
        XCTAssertFalse(send.isEnabled)
        let field = app.textViews["Share your thoughts with us…"].firstMatch.exists
            ? app.textViews["Share your thoughts with us…"].firstMatch
            : app.textFields["Share your thoughts with us…"].firstMatch
        field.typeText("The diff froze")
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(element("Thanks for your feedback!").waitForExistence(timeout: 5))
    }

    func testReleaseNotesMarkTheCurrentVersion() {
        launch("release-notes")
        XCTAssertTrue(element("Release notes").waitForExistence(timeout: 5))
        XCTAssertTrue(element("v0.1.58").waitForExistence(timeout: 3))
        XCTAssertTrue(element("v0.1.57, Current").exists || element("Current").exists)
        button("Back").tap()
        XCTAssertTrue(app.buttons["Release notes"].waitForExistence(timeout: 3))
    }

    func testVersionChipOpensReleaseNotes() {
        launch("list")
        XCTAssertTrue(button("Release notes").waitForExistence(timeout: 5))
        button("Release notes").tap()
        XCTAssertTrue(element("v0.1.58").waitForExistence(timeout: 5))
    }

    func testErrorPageRecovers() {
        launch("error-page")
        XCTAssertTrue(element("Something went wrong").waitForExistence(timeout: 8))
        button("Details").tap()
        button("Copy").tap()
        XCTAssertTrue(button("Copied").waitForExistence(timeout: 2))
        button("Retry").tap()
        XCTAssertTrue(element("If this keeps happening, reload the view or go back to the start.").waitForExistence(timeout: 8))
        button("Go to start").tap()
        XCTAssertFalse(element("Something went wrong").waitForExistence(timeout: 2))
    }
}
