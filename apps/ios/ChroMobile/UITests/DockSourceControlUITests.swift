import XCTest

/// The right dock's shell and Source Control on the fixture services (mock slots 8 and 21).
@MainActor
final class DockSourceControlUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func launch(_ screen: String, losingAnswers: Bool = false) {
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard", "-ChroScreen", screen] + (losingAnswers ? ["-ChroLoseAnswers"] : [])
        app.launch()
    }

    private func element(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func button(_ label: String) -> XCUIElement { SettledElement.wait(app.buttons[label].firstMatch) }

    func testRunShowsItsThreeChangesAgainstMain() {
        launch("source-control")
        XCTAssertTrue(element("README.md").waitForExistence(timeout: 5))
        XCTAssertTrue(element("src/stock.test.ts").exists)
        XCTAssertTrue(element("src/stock.ts").exists)
        XCTAssertTrue(element("Changes (3)").exists)
        XCTAssertTrue(app.staticTexts["ch/e7a6-add-removestock-to-stock"].exists)
        XCTAssertTrue(button("Push (0)").exists)
        XCTAssertTrue(button("Pull (0)").exists)
        XCTAssertFalse(button("Rebase onto main").isEnabled)
        XCTAssertTrue(button("Merge into main").isEnabled)
    }

    func testTreeViewNestsUnderFoldersAndCollapses() {
        launch("source-control")
        XCTAssertTrue(element("README.md").waitForExistence(timeout: 5))
        button("View as Tree").tap()
        XCTAssertTrue(button("src").waitForExistence(timeout: 2))
        button("src").tap()
        XCTAssertFalse(element("src/stock.ts").waitForExistence(timeout: 1))
        button("View as List").tap()
        XCTAssertTrue(element("src/stock.ts").waitForExistence(timeout: 2))
    }

    func testUncommittedScopeShowsTheCommitBox() {
        launch("source-control")
        XCTAssertTrue(button("Uncommitted").waitForExistence(timeout: 5))
        button("Uncommitted").tap()
        XCTAssertTrue(element("Staged Changes (0)").waitForExistence(timeout: 2))
        XCTAssertTrue(element("Changes (0)").exists)
        XCTAssertTrue(app.textFields["Commit message"].exists || app.textViews["Commit message"].exists)
        XCTAssertFalse(button("Commit").isEnabled)
        XCTAssertFalse(app.buttons["Rebase onto main"].firstMatch.isEnabled)
    }

    func testMergeLandsAndDisablesItself() {
        launch("source-control")
        XCTAssertTrue(button("Merge into main").waitForExistence(timeout: 5))
        button("Merge into main").tap()
        XCTAssertTrue(button("Merged").waitForExistence(timeout: 3))
        XCTAssertFalse(button("Merged").isEnabled)
    }

    func testPushConfirmsWithAToast() {
        launch("source-control")
        XCTAssertTrue(button("Push (0)").waitForExistence(timeout: 5))
        button("Push (0)").tap()
        XCTAssertTrue(element("Push to remote").waitForExistence(timeout: 3))
    }

    func testRebaseStopsOnTheReadmeConflict() {
        launch("conflict")
        XCTAssertTrue(button("Rebase onto main").waitForExistence(timeout: 5))
        XCTAssertTrue(element("2 behind").exists)
        button("Rebase onto main").tap()
        XCTAssertTrue(element("Merge conflict detected. Resolve conflicts and retry.").waitForExistence(timeout: 3))
        XCTAssertTrue(element("Resolve 1 conflicted file to continue").waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["No branch"].exists)
        XCTAssertFalse(button("Rebase onto main").isEnabled)
        XCTAssertFalse(button("Merge into main").isEnabled)
        XCTAssertTrue(element(".claude/skills/restock-check/SKILL.md").exists)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "source-control-conflict"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testRowOpensItsDiffAndTheSheetCloses() {
        launch("source-control")
        XCTAssertTrue(button("src/stock.ts").waitForExistence(timeout: 5))
        button("src/stock.ts").tap()
        XCTAssertTrue(element("Diff").waitForExistence(timeout: 3))
        XCTAssertTrue(element("@@ -3,3 +3,10 @@").waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Done"].exists)
    }

    func testSwitcherSelectsPanelsAndRemembersTheLastOne() {
        launch("source-control")
        XCTAssertTrue(button("Source Control").waitForExistence(timeout: 5))
        XCTAssertTrue(button("Source Control").isSelected)
        button("Files").tap()
        XCTAssertTrue(button("Files").isSelected)
        XCTAssertFalse(element("Changes (3)").exists)
        button("Source Control").tap()
        XCTAssertTrue(element("Changes (3)").waitForExistence(timeout: 3))
    }

    func testAChangeWhoseAnswerWasLostShowsWhatActuallyHappened() {
        // The desktop staged the file but its answer never arrived (deadline or disconnect):
        // the panel reports the failure and reads the checkout again.
        launch("file-editing", losingAnswers: true)
        let line = app.staticTexts["Tracks on-hand and reserved stock for every SKU."]
        XCTAssertTrue(line.waitForExistence(timeout: 5))
        line.tap()
        XCTAssertTrue(app.textViews["prose-line"].waitForExistence(timeout: 3))
        app.typeText(" Updated")
        button("Done").tap()
        button("Back").tap()
        button("Open right panel").tap()
        button("Source Control").tap()
        XCTAssertTrue(element("Changes (1)").waitForExistence(timeout: 5))
        button("Stage All").tap()
        // The desktop's git-error rule prefixes a message it does not recognize.
        XCTAssertTrue(element("Git error: The desktop did not answer in time.").waitForExistence(timeout: 3))
        XCTAssertTrue(element("Staged Changes (1)").waitForExistence(timeout: 3))
        XCTAssertTrue(element("Changes (0)").exists)
    }
}
