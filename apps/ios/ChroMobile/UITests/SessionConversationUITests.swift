import XCTest

/// Drives the session screen on the fixture services (mock slots 5-7, 11, 20 and the conflict state).
@MainActor
final class SessionConversationUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func open(_ sessionID: String, screen: String = "session", arguments: [String] = []) {
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard", "-ChroScreen", screen, "-ChroFocus", sessionID] + arguments
        app.launch()
    }

    private func text(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func containing(_ fragment: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch
    }

    private func button(_ label: String) -> XCUIElement { SettledElement.wait(app.buttons[label].firstMatch) }

    private func type(_ prompt: String) {
        let editor = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        editor.tap()
        editor.typeText(prompt)
    }

    func testRunningSessionQueuesEditsAndRemovesAMessage() {
        open("9b07c2d1-rec")
        XCTAssertTrue(text("Long stock reconciliation run").waitForExistence(timeout: 5))
        XCTAssertTrue(button("Stop").exists)
        XCTAssertFalse(app.buttons["Add to queue"].exists, "nothing typed yet")
        type("Then summarize the batches")
        button("Add to queue").tap()
        XCTAssertTrue(text("1 in queue").waitForExistence(timeout: 3))
        XCTAssertTrue(text("Then summarize the batches").exists)
        button("Edit").tap()
        let field = app.textFields["Edit"].exists ? app.textFields["Edit"] : app.textViews["Edit"]
        XCTAssertTrue(field.waitForExistence(timeout: 2))
        field.typeText(" twice")
        button("Save").tap()
        XCTAssertTrue(text("Then summarize the batches twice").waitForExistence(timeout: 3))
        button("Remove").tap()
        XCTAssertFalse(text("1 in queue").waitForExistence(timeout: 1))
    }

    func testStopEndsTheTurn() {
        open("9b07c2d1-rec")
        XCTAssertTrue(button("Stop").waitForExistence(timeout: 5))
        button("Stop").tap()
        XCTAssertTrue(button("Cmd or Ctrl + Enter to send").waitForExistence(timeout: 4), "the composer is idle again")
    }

    func testQuestionIsAnsweredStepByStep() {
        open("5c1e0f6a-pol")
        XCTAssertTrue(text("Which restock policy should the reconciliation use?").waitForExistence(timeout: 5))
        XCTAssertTrue(text("Policy • Waiting for response...").exists || containing("Waiting for response...").exists)
        button("Weekly batch Restock every Monday from last week sales").tap()
        XCTAssertTrue(text("Which events should notify the store manager?").waitForExistence(timeout: 2))
        XCTAssertTrue(button("Back").exists)
        XCTAssertFalse(button("Finish").isEnabled)
        button("Stock reaches 0 One message per SKU").tap()
        XCTAssertTrue(button("Finish").isEnabled)
        button("Finish").tap()
        XCTAssertFalse(text("Which events should notify the store manager?").waitForExistence(timeout: 3))
        // The timeline closes once nothing waits on the user; opening it shows the answer card.
        let header = app.buttons["AskUserQuestion"].firstMatch
        let resolved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == 'Collapsed'"), object: header)
        XCTAssertEqual(XCTWaiter.wait(for: [resolved], timeout: 4), .completed, "the approval resolved")
        header.tap()
        // The opened timeline grows below the fold of the lazily drawn conversation.
        app.scrollViews.firstMatch.swipeUp()
        XCTAssertTrue(text("Answers").waitForExistence(timeout: 3), "the transcript row shows the answers")
    }

    func testMcpApprovalDecision() {
        open("e4a2b9c0-aud")
        XCTAssertTrue(text("Allow the github MCP server to run create_pull_request?").waitForExistence(timeout: 5))
        XCTAssertTrue(text("Outside the sandbox").exists || containing("OUTSIDE").exists || text("Outside the sandbox".uppercased()).exists)
        XCTAssertTrue(text("inventory-service").exists)
        button("Deny").tap()
        XCTAssertFalse(text("Allow the github MCP server to run create_pull_request?").waitForExistence(timeout: 3))
    }

    func testFailedRunShowsTheErrorAndSendsANewTurn() {
        open("4a53c7f9-sum")
        XCTAssertTrue(containing("num_turns").waitForExistence(timeout: 5), "the error card")
        XCTAssertTrue(containing("<synthetic>").exists, "the Run with line")
        XCTAssertFalse(button("Cmd or Ctrl + Enter to send").isEnabled)
        type("Summarize it again")
        button("Cmd or Ctrl + Enter to send").tap()
        XCTAssertTrue(text("Summarize it again").waitForExistence(timeout: 3))
        XCTAssertTrue(button("Stop").waitForExistence(timeout: 3), "the session runs")
    }

    // MARK: A turn at work (thinking-steps.tsx, task-conversation.tsx)

    /// A long finished conversation, answered one step per `pace` ms by the fixture's agent.
    private func sendWorkingTurn(pace: Int = 900) -> XCUIElement {
        open("7a3f5d10-add", arguments: ["-ChroReplyPace", String(pace)])
        let send = button("Cmd or Ctrl + Enter to send")
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        type("Reconcile every batch")
        send.tap()
        return app.scrollViews["conversation"]
    }

    private func batch(_ number: Int) -> XCUIElement { containing("Batch \(number) matched all five SKUs") }

    /// Wholly inside the conversation's viewport.
    private func isShown(_ element: XCUIElement, in scroll: XCUIElement) -> Bool {
        element.exists && !element.frame.isEmpty && scroll.frame.insetBy(dx: 0, dy: -1).contains(element.frame)
    }

    private func waitUntil(_ timeout: TimeInterval, _ condition: @escaping () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return condition()
    }

    func testAWorkingTurnShimmersUntilItEnds() {
        _ = sendWorkingTurn()
        let live = app.buttons["steps-live"].firstMatch
        XCTAssertTrue(live.waitForExistence(timeout: 3), "the working sentinel shimmers from the send")
        XCTAssertEqual(live.label, "Thinking", "nothing to summarize yet: the desktop's static label")
        XCTAssertTrue(batch(2).waitForExistence(timeout: 6))
        XCTAssertTrue(app.buttons["steps-live"].firstMatch.exists, "still at work between steps")
        XCTAssertTrue(containing("All 12 batches are reconciled.").waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["steps-live"].firstMatch.exists, "the shimmer ends with the turn")
    }

    func testTheConversationFollowsNewStepsWhileTheReaderIsAtTheEnd() {
        let scroll = sendWorkingTurn()
        for number in [2, 4, 6] {
            XCTAssertTrue(waitUntil(8) { self.isShown(self.batch(number), in: scroll) }, "batch \(number) comes into view by itself")
        }
    }

    func testScrollingUpStopsFollowingAndReturningToTheEndResumesIt() {
        let scroll = sendWorkingTurn()
        XCTAssertTrue(waitUntil(8) { self.isShown(self.batch(2), in: scroll) })
        scroll.swipeDown()
        Thread.sleep(forTimeInterval: 1)
        let anchor = app.staticTexts.allElementsBoundByIndex.first { $0.exists && scroll.frame.contains($0.frame) && !$0.label.isEmpty }
        let resting = anchor?.frame
        XCTAssertNotNil(resting)
        // Three more batches land below the reader.
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(anchor?.frame, resting, "the view did not move")
        XCTAssertFalse(isShown(batch(5), in: scroll), "new steps stay below the reader")
        // Back at the end, the conversation follows again.
        scroll.swipeUp(velocity: .fast)
        scroll.swipeUp(velocity: .fast)
        XCTAssertTrue(waitUntil(10) { self.isShown(self.batch(9), in: scroll) || self.isShown(self.batch(10), in: scroll) }, "following resumed")
    }

    func testFindCountsMatchesAcrossTheConversation() {
        open("9b07c2d1-rec")
        button("Find in conversation").tap()
        let field = app.textFields["Find in conversation"]
        XCTAssertTrue(field.waitForExistence(timeout: 2))
        field.typeText("batch")
        XCTAssertTrue(text("1/5").waitForExistence(timeout: 2))
        button("Next match").tap()
        XCTAssertTrue(text("2/5").exists)
        button("Previous match").tap()
        button("Previous match").tap()
        XCTAssertTrue(text("5/5").exists, "wraps around")
        button("Close find bar").tap()
        XCTAssertFalse(field.exists)
    }

    func testReferencesOpenTheDelegatedSession() {
        open("7a3f5d10-add")
        button("Open references").tap()
        XCTAssertTrue(text("References").waitForExistence(timeout: 2))
        let row = containing("Delegated to")
        XCTAssertTrue(row.exists)
        row.tap()
        XCTAssertTrue(text("Review removeStock in src/stock.ts for edge cases").waitForExistence(timeout: 3))
    }

    func testContinueInANewSessionFromATurn() {
        open("7a3f5d10-add")
        let continueButtons = app.buttons.matching(identifier: "Continue in a new session from here")
        XCTAssertTrue(continueButtons.firstMatch.waitForExistence(timeout: 5))
        continueButtons.element(boundBy: continueButtons.count - 1).tap()
        XCTAssertTrue(text("Add removeStock to stock module (2)").waitForExistence(timeout: 3))
        XCTAssertTrue(button("Continued from task").waitForExistence(timeout: 3))
    }

    func testContinuedSessionLinksBackToItsSource() {
        open("bd50a1e2-img", screen: "continue-in")
        XCTAssertTrue(text("Add stock report images (2)").waitForExistence(timeout: 5))
        button("Continued from task").tap()
        XCTAssertTrue(text("Add stock report images").waitForExistence(timeout: 3))
    }

    func testConflictBannerAbortsAfterConfirmation() {
        open("c4534455-rw", screen: "session-conflict")
        XCTAssertTrue(containing("Rebase in progress: 'ch/c453-reword-readme-summary'").waitForExistence(timeout: 5))
        XCTAssertTrue(text("Conflicted files (1):").exists)
        XCTAssertFalse(app.buttons["Open in Editor"].exists, "the desktop editor is not reachable from the phone")
        button("Abort Rebase").tap()
        let confirm = app.buttons.matching(identifier: "Abort Rebase")
        XCTAssertTrue(confirm.element(boundBy: 1).waitForExistence(timeout: 2) || app.sheets.buttons["Abort Rebase"].exists)
        (app.sheets.buttons["Abort Rebase"].exists ? app.sheets.buttons["Abort Rebase"] : confirm.element(boundBy: confirm.count - 1)).tap()
        XCTAssertFalse(containing("Rebase in progress").waitForExistence(timeout: 3))
    }

    func testTitleRenameAndMessageNavigator() {
        open("7a3f5d10-add")
        let title = app.buttons["Add removeStock to stock module"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap()
        let field = app.textFields["Edit title"]
        XCTAssertTrue(field.waitForExistence(timeout: 2))
        field.clearAndType("Stock guards")
        field.typeText("\n")
        XCTAssertTrue(app.buttons["Stock guards"].waitForExistence(timeout: 3))
        button("Jump to a past message").tap()
        XCTAssertTrue(text("Jump to a past message").waitForExistence(timeout: 2))
        XCTAssertTrue(containing("In src/stock.ts add an exported function").exists)
    }

    func testBranchChipFacts() {
        open("7a3f5d10-add")
        let chip = app.buttons["Open Source Control"]
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        chip.press(forDuration: 0.8)
        XCTAssertTrue(text("Execution").waitForExistence(timeout: 2) || containing("Worktree").exists)
        XCTAssertTrue(containing("7a3f").exists)
    }
}

extension XCUIElement {
    func clearAndType(_ value: String) {
        if let current = self.value as? String, !current.isEmpty {
            typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        typeText(value)
    }
}
