import XCTest

/// Drives the app against a real, isolated chro-server (no fixture services).
///
/// Skipped unless the test runner gets the environment below; xcodebuild passes
/// variables prefixed with `TEST_RUNNER_` through to the runner:
///
///     TEST_RUNNER_CHRO_LIVE_PAIRING_URL=chro://pair?code=...   (Settings > Mobile, Copy pairing link)
///     TEST_RUNNER_CHRO_LIVE_SHOTS=/path/to/dir                  (screenshots, one PNG per step)
///
/// The tests run in name order and share the app's keychain: `test01Pairs` pairs,
/// the later tests reuse that pairing.
@MainActor
final class LiveDesktopUITests: XCTestCase {
    private var app: XCUIApplication!
    private let env = ProcessInfo.processInfo.environment

    override func setUp() async throws {
        continueAfterFailure = false
        guard env["CHRO_LIVE_SHOTS"] != nil else {
            throw XCTSkip("Needs TEST_RUNNER_CHRO_LIVE_SHOTS and a paired or pairable chro-server")
        }
    }

    // MARK: helpers

    private func launch(_ arguments: [String] = []) {
        app = XCUIApplication()
        app.launchArguments = arguments
        app.launch()
    }

    private func text(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func containing(_ fragment: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch
    }

    private func button(_ label: String) -> XCUIElement { SettledElement.wait(app.buttons[label].firstMatch) }

    /// Saves the screen as `<CHRO_LIVE_SHOTS>/<name>.png`.
    private func shot(_ name: String, settle: TimeInterval = 1.2) {
        Thread.sleep(forTimeInterval: settle)
        guard let dir = env["CHRO_LIVE_SHOTS"] else { return }
        let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
    }

    // MARK: walkthrough

    /// Needs `TEST_RUNNER_CHRO_LIVE_PREEMPTED_PAIRING_URL`: an offer whose ticket another
    /// client already exchanged (`.claude/mobile_pair_probe.py <server> --preempt`). The
    /// desktop refuses this phone's exchange, so pairing fails and nothing is saved.
    func test00PairingFailsWhenTheTicketWasExchangedElsewhere() throws {
        guard let link = env["CHRO_LIVE_PREEMPTED_PAIRING_URL"], let url = URL(string: link) else {
            throw XCTSkip("Needs TEST_RUNNER_CHRO_LIVE_PREEMPTED_PAIRING_URL")
        }
        launch()
        app.open(url)
        expect(text("Pair with this desktop?"), "the link confirmation")
        button("Pair").tap()
        expect(text("Couldn't pair"), "the pairing failure", timeout: 40)
        XCTAssertTrue(containing("Pairing failed:").exists)
        shot("phone-13-pairing-exchange-refused", settle: 0.5)
    }

    func test01Pairs() throws {
        guard let link = env["CHRO_LIVE_PAIRING_URL"], let url = URL(string: link) else {
            throw XCTSkip("Needs TEST_RUNNER_CHRO_LIVE_PAIRING_URL")
        }
        launch()
        shot("phone-13-pairing-unpaired")
        // Simulators have no camera: the paste screen, with the link typed in.
        let field = app.textFields["Pairing code"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(link)
        shot("phone-13-pairing-confirm")
        app.buttons.matching(NSPredicate(format: "label == 'Pair' AND enabled == true")).firstMatch.tap()
        let listed = text("Projects").waitForExistence(timeout: 30)
        if !listed {
            shot("phone-13-pairing-failed", settle: 0)
            let shown = app.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: " | ")
            XCTFail("the paired app shows the session list; screen: \(shown)")
        }
        shot("phone-01-list-after-pairing", settle: 3)
    }

    private func type(_ prompt: String) {
        let editor = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        editor.tap()
        editor.typeText(prompt)
    }

    private var project: String { env["CHRO_LIVE_PROJECT"] ?? "stockapp" }

    func test02ListPaletteAndHome() {
        launch()
        XCTAssertTrue(text(project).waitForExistence(timeout: 20))
        shot("phone-01-sessions")
        button("Search").tap()
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 3))
        shot("phone-02-search")
        app.textFields.firstMatch.tap()
        app.textFields.firstMatch.typeText("total")
        XCTAssertTrue(containing("Explain total()").waitForExistence(timeout: 3))
        shot("phone-02-search-query")
        button("Done").tap()
        XCTAssertTrue(text(project).waitForExistence(timeout: 5))
        text(project).tap()
        XCTAssertTrue(text("Home").waitForExistence(timeout: 5))
        shot("phone-03-home", settle: 2)
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model: '")).firstMatch.tap()
        Thread.sleep(forTimeInterval: 1)
        shot("phone-04-new-session-model-sheet")
    }

    func test03ConversationOfAFinishedSession() {
        openSession("Add removeStock to stock module")
        XCTAssertTrue(containing("removeStock").waitForExistence(timeout: 10))
        shot("phone-05-conversation-finished", settle: 3)
    }

    func test04NewSessionRunsQueuesAndStops() {
        launch()
        XCTAssertTrue(text(project).waitForExistence(timeout: 20))
        text(project).tap()
        XCTAssertTrue(text("Home").waitForExistence(timeout: 5))
        // The cheapest model the host offers, when it lists one.
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model: '")).firstMatch
        model.tap()
        let haiku = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Haiku'")).firstMatch
        if !haiku.waitForExistence(timeout: 2), button("Model").exists { button("Model").tap() }
        if haiku.waitForExistence(timeout: 2) { haiku.tap() } else { app.swipeDown(velocity: .fast) }
        Thread.sleep(forTimeInterval: 0.8)
        type("List every file in this repository with one line about each. Read each file before describing it.")
        shot("phone-04-home-composer")
        button("Send").tap()
        XCTAssertTrue(button("Stop").waitForExistence(timeout: 30), "the new session runs")
        shot("phone-05-running", settle: 4)
        type("Then say done.")
        XCTAssertTrue(button("Add to queue").waitForExistence(timeout: 3))
        button("Add to queue").tap()
        XCTAssertTrue(text("1 in queue").waitForExistence(timeout: 5))
        shot("phone-05-queued")
        button("Stop").tap()
        XCTAssertTrue(button("Stop").waitForNonExistence(timeout: 30) || containing("in queue").exists)
        shot("phone-05-stopped", settle: 3)
    }

    private func row(_ name: String) -> XCUIElement { app.descendants(matching: .any)["tree:\(name)"].firstMatch }

    /// Opens a session through the palette (the list folds after five rows).
    private func openSession(_ title: String) {
        launch()
        expect(text(project), "the list", timeout: 20)
        button("Search").tap()
        let field = app.textFields.firstMatch
        expect(field, "the palette")
        field.tap()
        field.typeText(title)
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "\(title) · ")).firstMatch
        expect(row, title)
        row.tap()
        expect(button("Open right panel"), "the conversation")
    }

    private func openHome() {
        launch()
        XCTAssertTrue(text(project).waitForExistence(timeout: 20))
        text(project).tap()
        XCTAssertTrue(text("Home").waitForExistence(timeout: 5))
    }

    func test05DockSourceControlDiffAndFile() {
        openSession("Add removeStock to stock module")
        button("Open right panel").tap()
        XCTAssertTrue(button("Source Control").waitForExistence(timeout: 5))
        button("Source Control").tap()
        XCTAssertTrue(button("src/stock.ts").waitForExistence(timeout: 10), "the session's change against main")
        shot("phone-08-source-control", settle: 2)
        button("src/stock.ts").tap()
        XCTAssertTrue(containing("removeStock").waitForExistence(timeout: 10))
        shot("phone-09-diff", settle: 2)
        button("Back").tap()

        button("Open right panel").tap()
        XCTAssertTrue(button("Files").waitForExistence(timeout: 5))
        button("Files").tap()
        XCTAssertTrue(row("src").waitForExistence(timeout: 10))
        shot("phone-08-dock-files", settle: 1.5)
        row("src").tap()
        XCTAssertTrue(row("stock.ts").waitForExistence(timeout: 5))
        row("stock.ts").tap()
        let editor = app.textViews["code-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        shot("phone-10-file", settle: 2)
        editor.tap()
        XCTAssertTrue(button("Done").waitForExistence(timeout: 3))
        app.typeText("// edited from the phone\n")
        button("Done").tap()
        shot("phone-10-file-saved", settle: 3)
    }

    func test06SearchGallerySkillsAndProseEditing() {
        openHome()
        button("Search files…").tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("reorder")
        XCTAssertTrue(containing("notes.md").waitForExistence(timeout: 10))
        shot("phone-08-dock-search", settle: 1.5)
        button("Done").tap()
        XCTAssertTrue(button("Gallery").waitForExistence(timeout: 5))

        button("Gallery").tap()
        XCTAssertTrue(containing("chart.png").waitForExistence(timeout: 10))
        shot("phone-15-gallery", settle: 2)
        button("Back").tap()

        button("Skills").tap()
        Thread.sleep(forTimeInterval: 2)
        shot("phone-16-skills", settle: 2)
        button("Back").tap()

        button("Open right panel").tap()
        XCTAssertTrue(button("Files").waitForExistence(timeout: 5))
        button("Files").tap()
        XCTAssertTrue(row("README.md").waitForExistence(timeout: 10))
        row("README.md").tap()
        let line = containing("Tiny inventory helpers")
        XCTAssertTrue(line.waitForExistence(timeout: 10))
        shot("phone-22-file-editing", settle: 2)
        line.tap()
        XCTAssertTrue(button("Done").waitForExistence(timeout: 3))
        app.typeText(" Edited on the phone.")
        button("Done").tap()
        shot("phone-22-file-editing-saved", settle: 3)
    }

    func test07SettingsAndSystemScreens() {
        launch()
        XCTAssertTrue(text(project).waitForExistence(timeout: 20))
        button("Settings").tap()
        XCTAssertTrue(button("Appearance").waitForExistence(timeout: 5))
        shot("phone-17-settings")
        button("Appearance").tap()
        XCTAssertTrue(button("Theme").waitForExistence(timeout: 5))
        shot("phone-17-settings-appearance")
        button("Theme").tap()
        button("Dark").tap()
        XCTAssertEqual(button("Theme").value as? String, "Dark")
        shot("phone-17-settings-dark")
        button("Back").tap()
        for pane in ["General", "Workspace", "Editor", "Notifications", "MCP", "Agents"] {
            XCTAssertTrue(button(pane).waitForExistence(timeout: 5), pane)
            button(pane).tap()
            Thread.sleep(forTimeInterval: 1.5)
            // The MCP pane shows the host's MCP config, which can hold secrets: no screenshot.
            if pane != "MCP" { shot("phone-17-settings-\(pane.lowercased())") }
            button("Back").tap()
        }
        button("Done").tap()

        // The theme belongs to this phone: it survives a relaunch.
        app.terminate()
        launch()
        XCTAssertTrue(text(project).waitForExistence(timeout: 20))
        shot("phone-01-sessions-dark")
        button("Settings").tap()
        button("Appearance").tap()
        XCTAssertEqual(button("Theme").value as? String, "Dark")
        button("Theme").tap()
        button("System").tap()
        button("Done").tap()

        button("Agent status").tap()
        Thread.sleep(forTimeInterval: 3)
        shot("phone-agent-status")
        button("Done").tap()
        button("Feedback").tap()
        XCTAssertTrue(button("Report a bug").waitForExistence(timeout: 5))
        shot("phone-feedback")
        button("Close").tap()

        button("Release notes").tap()
        Thread.sleep(forTimeInterval: 1.5)
        shot("phone-23-release-notes")
        button("Back").tap()

        button("Open another project").tap()
        XCTAssertTrue(button("New workspace").waitForExistence(timeout: 5))
        shot("phone-18-open-another-project")
        button("New workspace").tap()
        Thread.sleep(forTimeInterval: 2.5)
        shot("phone-18-workspace-picker")
        button("Cancel").tap()
    }

    /// Fails with the labels on screen, for a walkthrough step that did not land.
    private func expect(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 10) {
        guard !element.waitForExistence(timeout: timeout) else { return }
        shot("failed-\(name.replacingOccurrences(of: " ", with: "_"))", settle: 0)
        let shown = app.descendants(matching: .any).allElementsBoundByIndex.prefix(80).map(\.label).filter { !$0.isEmpty }
        XCTFail("\(what); screen: \(shown.joined(separator: " | "))")
    }

    func test08NewChat() {
        launch()
        expect(text(project), "the list", timeout: 20)
        app.buttons.matching(identifier: "New chat").firstMatch.tap()
        expect(text("New session"), "the new-chat launcher")
        shot("phone-12-new-chat")
    }

    /// Commits the phone's own edit, then rebases onto a main that changed the same
    /// README lines: the host stops on a real conflict, which the conversation aborts.
    func test09CommitRebaseConflictAndAbort() {
        openSession("Add removeStock to stock module")
        button("Open right panel").tap()
        expect(button("Source Control"), "the dock")
        button("Source Control").tap()
        expect(button("Uncommitted"), "the scope switch")
        button("Uncommitted").tap()
        expect(button("Stage All"), "the commit tools")
        button("Stage All").tap()
        let message = app.textFields["Commit message"].exists ? app.textFields["Commit message"] : app.textViews["Commit message"]
        expect(message, "the commit message field")
        message.tap()
        message.typeText("Note the phone edit")
        shot("phone-08-source-control-commit", settle: 1)
        button("Commit").tap()
        expect(text("Changes (0)"), "the commit landed", timeout: 15)
        button("All changes").tap()
        expect(button("Rebase onto main"), "rebase")
        shot("phone-21-behind-main", settle: 2)
        button("Rebase onto main").tap()
        expect(containing("conflict"), "the host reports the conflict", timeout: 20)
        shot("phone-21-conflict", settle: 2)
        button("Done").tap()
        expect(containing("Rebase in progress"), "the conversation's conflict banner", timeout: 15)
        shot("phone-21-conflict-banner", settle: 1.5)
        button("Abort Rebase").tap()
        let confirm = app.buttons.matching(identifier: "Abort Rebase")
        _ = confirm.element(boundBy: 1).waitForExistence(timeout: 3)
        (app.sheets.buttons["Abort Rebase"].exists ? app.sheets.buttons["Abort Rebase"] : confirm.element(boundBy: confirm.count - 1)).tap()
        XCTAssertTrue(containing("Rebase in progress").waitForNonExistence(timeout: 15))
        shot("phone-21-aborted", settle: 2)
    }

    func test10FailedRunAndContinueIn() {
        openSession("Summarize stock module")
        expect(containing("not-a-real-model"), "the failed run's error", timeout: 15)
        shot("phone-11-failed", settle: 2)
        openSession("Add removeStock to stock module")
        let continueButtons = app.buttons.matching(identifier: "Continue in a new session from here")
        expect(continueButtons.firstMatch, "continue in")
        continueButtons.element(boundBy: continueButtons.count - 1).tap()
        expect(button("Continued from task"), "the continued session", timeout: 20)
        shot("phone-20-continue-in", settle: 3)
    }


    /// Add photos > the system picker > upload to the host > send with the image.
    func test11AttachmentsUploadAndSend() {
        openSession("Explain total()")
        button("Add context").tap()
        expect(button("Add photos"), "the + sheet")
        button("Add photos").tap()
        let photo = app.images.matching(NSPredicate(format: "label BEGINSWITH 'Photo'")).firstMatch
        expect(photo, "the photo picker", timeout: 15)
        // The picker runs out of process: its cells report not hittable, so tap the point.
        photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        shot("phone-19-attachments-picker", settle: 1)
        if app.buttons["Add"].waitForExistence(timeout: 3) { app.buttons["Add"].tap() }
        Thread.sleep(forTimeInterval: 4)
        shot("phone-19-attachments-uploaded", settle: 1)
        type("What colour is this image? Answer in three words.")
        button("Cmd or Ctrl + Enter to send").tap()
        expect(button("Stop"), "the turn with the image runs", timeout: 30)
        shot("phone-19-attachments-sent", settle: 3)
        XCTAssertTrue(button("Stop").waitForNonExistence(timeout: 90), "the turn finishes")
        shot("phone-19-attachments-answered", settle: 2)
    }

    /// Run with the host's `chro:setup-onboarding-complete` cleared: the shared flag brings
    /// the phone into onboarding, with the host's real install status.
    func test12OnboardingOnTheHost() {
        launch()
        expect(text("Welcome to Chro"), "the welcome step", timeout: 20)
        shot("phone-13-onboarding-welcome")
        button("Get started").tap()
        expect(text("Pick your coding agent"), "the agent step")
        Thread.sleep(forTimeInterval: 3)
        shot("phone-13-onboarding-agent")
        app.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Claude Code'")).firstMatch.tap()
        button("Continue").tap()
        expect(text("Set up your agents"), "the setup step")
        shot("phone-13-onboarding-setup")
        button("Continue").tap()
        expect(text("Make it feel like home"), "the appearance step")
        shot("phone-13-onboarding-appearance")
        button("Continue").tap()
        expect(text("Open your first project"), "the last step")
        shot("phone-13-onboarding-first-project")
    }

    /// Revoked from the desktop while open: the phone must say so and offer pairing again.
    /// The host side writes `CHRO_LIVE_REVOKED_FLAG` once it has revoked the device.
    func test13RevokedFromTheDesktop() throws {
        guard let flag = env["CHRO_LIVE_REVOKED_FLAG"] else { throw XCTSkip("Needs TEST_RUNNER_CHRO_LIVE_REVOKED_FLAG") }
        launch()
        if !FileManager.default.fileExists(atPath: flag) {
            expect(text(project), "the list", timeout: 20)
            shot("phone-revoke-before")
        }
        let deadline = Date().addingTimeInterval(240)
        while !FileManager.default.fileExists(atPath: flag), Date() < deadline { Thread.sleep(forTimeInterval: 1) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: flag), "the desktop revoked the device")
        expect(containing("refused this phone"), "the refused banner", timeout: 30)
        shot("phone-revoke-after", settle: 1)
        // The workspace below the banner is read-only (the list, or the first-launch screen
        // when nothing was loaded before the refusal).
        if app.buttons["Search"].exists {
            app.buttons["Search"].firstMatch.tap()
            XCTAssertFalse(app.textFields["Where would you like to go?"].waitForExistence(timeout: 2), "the workspace is read-only")
        } else {
            app.buttons["Open folder"].firstMatch.tap()
            XCTAssertFalse(text("Select workspace").waitForExistence(timeout: 2), "the workspace is read-only")
        }

        // Pair again with a fresh offer from the desktop.
        guard let link = env["CHRO_LIVE_PAIRING_URL"], let url = URL(string: link) else { return }
        button("Pair again").tap()
        expect(text("Pair with desktop"), "the pairing screen")
        shot("phone-revoke-pair-again", settle: 1)
        app.open(url)
        expect(text("Pair with this desktop?"), "the link confirmation")
        button("Pair").tap()
        expect(text(project), "the workspace again", timeout: 30)
        XCTAssertFalse(containing("refused this phone").exists)
        shot("phone-revoke-repaired", settle: 2)
    }

    /// Agent status with the host's usage, and Settings > MCP on a throwaway config whose
    /// credentials are fake: the phone sees only `__chro_hidden__`, and saving an edit made
    /// around them leaves the host's values in place (checked on the host afterwards).
    func test14AgentStatusUsageAndHiddenMcpCredentials() {
        launch()
        expect(button("Agent status"), "the list's top bar", timeout: 20)
        button("Agent status").tap()
        expect(containing("% cached"), "the usage meter")
        shot("phone-agent-status-usage")
        button("Done").tap()

        button("Settings").tap()
        expect(button("MCP"), "the settings panes")
        button("MCP").tap()
        let editor = app.textViews["Server Configuration (JSON)"].firstMatch.exists
            ? app.textViews["Server Configuration (JSON)"].firstMatch
            : app.textFields["Server Configuration (JSON)"].firstMatch
        expect(editor, "the MCP editor")
        let deadline = Date().addingTimeInterval(10)
        while !((editor.value as? String) ?? "").contains("__chro_hidden__"), Date() < deadline { Thread.sleep(forTimeInterval: 0.5) }
        let shown = (editor.value as? String) ?? ""
        XCTAssertTrue(shown.contains("__chro_hidden__"), shown)
        for secret in ["FAKE0000", "FAKE1111", "fake-password", "fake-key-0000"] { XCTAssertFalse(shown.contains(secret), secret) }
        shot("phone-17-settings-mcp-hidden")

        // Keep every hidden string as it is and change something else.
        editor.tap()
        editor.press(forDuration: 1.0)
        let selectAll = app.menuItems["Select All"].firstMatch
        expect(selectAll, "the edit menu")
        selectAll.tap()
        editor.typeText(shown.replacingOccurrences(of: "\"command\": \"npx\"", with: "\"command\": \"bunx\""))
        let save = app.buttons["Save"].firstMatch
        XCTAssertTrue(save.isEnabled)
        save.tap()
        Thread.sleep(forTimeInterval: 3)
        XCTAssertFalse(containing("hidden value").exists)
        shot("phone-17-settings-mcp-saved")
    }

    /// A real host's session (`CHRO_LIVE_SESSION`: a fragment of its title,
    /// `CHRO_LIVE_SESSION_TEXT`: a phrase of its newest turn) shows its conversation.
    func test15ConversationOfARealSession() throws {
        guard let title = env["CHRO_LIVE_SESSION"], let phrase = env["CHRO_LIVE_SESSION_TEXT"] else {
            throw XCTSkip("Needs TEST_RUNNER_CHRO_LIVE_SESSION and TEST_RUNNER_CHRO_LIVE_SESSION_TEXT")
        }
        launch()
        expect(text(project), "the list", timeout: 20)
        button("Search").tap()
        let field = app.textFields.firstMatch
        expect(field, "the palette")
        field.tap()
        field.typeText(title)
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        expect(row, title)
        row.tap()
        expect(button("Open right panel"), "the conversation")
        let shown = containing(phrase).waitForExistence(timeout: 30)
        shot("phone-real-session-conversation", settle: 2)
        XCTAssertTrue(shown, "the newest turn; screen: \(app.staticTexts.allElementsBoundByIndex.prefix(40).map(\.label))")
    }

    /// A new session sent from the phone in `CHRO_LIVE_PROJECT`: the session screen keeps
    /// the prompt from the first frame and the reply streams in. Frames are saved every
    /// 100 ms after Send so a blank frame shows up in the shots directory.
    func test16NewSessionSentFromThePhoneStreams() {
        openHome()
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model: '")).firstMatch
        model.tap()
        let haiku = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Haiku'")).firstMatch
        if !haiku.waitForExistence(timeout: 2), button("Model").exists { button("Model").tap() }
        if haiku.waitForExistence(timeout: 2) { haiku.tap() } else { app.swipeDown(velocity: .fast) }
        Thread.sleep(forTimeInterval: 0.8)
        let prompt = "Reply with exactly one word: pong"
        type(prompt)
        button("Send").tap()
        for frame in 0..<20 { shot(String(format: "phone-send-frame-%02d", frame), settle: 0.1) }
        expect(containing(prompt), "the prompt on the session screen", timeout: 20)
        let reply = app.descendants(matching: .any).matching(NSPredicate(format: "label ==[c] 'pong' OR label ==[c] 'pong.'")).firstMatch
        expect(reply, "the streamed reply", timeout: 120)
        shot("phone-send-replied", settle: 1)
    }

    /// Wholly inside the conversation's viewport.
    private func isShown(_ element: XCUIElement, in scroll: XCUIElement) -> Bool {
        element.exists && !element.frame.isEmpty && scroll.frame.insetBy(dx: 0, dy: -1).contains(element.frame)
    }

    private func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return condition()
    }

    /// A real run that streams several steps: the working header shimmers at the end
    /// of the turn, the conversation follows it, scrolling up stops following and
    /// coming back to the end resumes it; the shimmer ends with the run.
    func test17WorkingRunShimmersAndFollows() {
        openHome()
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model: '")).firstMatch
        model.tap()
        let haiku = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Haiku'")).firstMatch
        if !haiku.waitForExistence(timeout: 2), button("Model").exists { button("Model").tap() }
        if haiku.waitForExistence(timeout: 2) { haiku.tap() } else { app.swipeDown(velocity: .fast) }
        Thread.sleep(forTimeInterval: 0.8)
        type("Use the Bash tool to run `cat batch1.csv`, then `sleep 4; cat batch2.csv`, then `sleep 4; cat batch3.csv`, then `sleep 4; cat batch4.csv`, "
            + "then `sleep 4; cat batch5.csv`, then `sleep 4; cat batch6.csv`, one separate Bash call each, in order. After each call write two short "
            + "sentences about what that file contains. Finish with a one-paragraph summary.")
        button("Send").tap()
        let live = app.buttons["steps-live"].firstMatch
        expect(live, "the working header", timeout: 20)
        let scroll = app.scrollViews["conversation"]
        shot("live-01-working", settle: 0.3)
        XCTAssertTrue(waitUntil(30) { app.buttons.matching(identifier: "steps").count >= 2 }, "several steps streamed")
        XCTAssertTrue(isShown(app.buttons["steps-live"].firstMatch, in: scroll), "following: the working header at the end is in view")
        shot("live-02-following", settle: 0.3)
        // Following carries the turn's first rows out of view once the turn outgrows the screen.
        let firstRow = containing("Run with").firstMatch
        XCTAssertTrue(waitUntil(90) { !isShown(firstRow, in: scroll) && app.buttons["steps-live"].firstMatch.exists }, "the end was followed past the screen")
        XCTAssertTrue(isShown(app.buttons["steps-live"].firstMatch, in: scroll))
        shot("live-02b-followed-past-the-screen", settle: 0)
        scroll.swipeDown()
        Thread.sleep(forTimeInterval: 1)
        shot("live-03-scrolled-up", settle: 0)
        Thread.sleep(forTimeInterval: 6)
        XCTAssertFalse(isShown(app.buttons["steps-live"].firstMatch, in: scroll), "not following: the end stays below the reader")
        shot("live-04-still-up", settle: 0)
        scroll.swipeUp(velocity: .fast)
        scroll.swipeUp(velocity: .fast)
        XCTAssertTrue(waitUntil(15) { isShown(app.buttons["steps-live"].firstMatch, in: scroll) || !app.buttons["Stop"].exists }, "following again")
        shot("live-05-following-again", settle: 0.3)
        XCTAssertTrue(waitUntil(150) { !app.buttons["steps-live"].firstMatch.exists && !app.buttons["Stop"].exists }, "the shimmer ends with the run")
        shot("live-06-finished", settle: 1)
    }

    // MARK: session list window (architecture doc §27)

    /// The element of `query` nearest below `anchor` (the rows a project header owns follow it).
    private func nearestBelow(_ query: XCUIElementQuery, _ anchor: XCUIElement) -> XCUIElement? {
        let top = anchor.frame.maxY
        return query.allElementsBoundByIndex.filter { $0.frame.minY >= top - 1 }.min { $0.frame.minY < $1.frame.minY }
    }

    /// The element of `query` on the same line as `anchor`.
    private func sameLine(_ query: XCUIElementQuery, _ anchor: XCUIElement) -> XCUIElement? {
        query.allElementsBoundByIndex.min { abs($0.frame.midY - anchor.frame.midY) < abs($1.frame.midY - anchor.frame.midY) }
    }

    /// `PATCH /rpc/tasks/:id/status` on the server, as the desktop's archive and restore do.
    private func setStatus(_ server: String, _ sessionID: String, _ status: String) {
        var request = URLRequest(url: URL(string: "\(server)/rpc/tasks/\(sessionID)/status")!)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{\"status\":\"\(status)\"}".utf8)
        let done = expectation(description: "status \(status)")
        URLSession.shared.dataTask(with: request) { _, response, _ in
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
    }

    /// A host with many sessions, of which the phone holds a window: pins, a project's
    /// "Show more" past the window, search of a session outside it, Home's Recent, and
    /// archive and restore from the desktop. Needs `CHRO_LIVE_WINDOW_PROJECT` (a project
    /// with more live sessions than the window holds), `CHRO_LIVE_WINDOW_OLD` (the title of
    /// its oldest live session), `CHRO_LIVE_WINDOW_PIN` (a live pinned session's title),
    /// `CHRO_LIVE_SEARCH_OLD` (a session of another project outside the window),
    /// `CHRO_LIVE_SERVER` and `CHRO_LIVE_STATUS_SESSION` (`id|title` of a session in the window).
    func test18SessionListWindowOnARealHost() throws {
        guard let project = env["CHRO_LIVE_WINDOW_PROJECT"], let old = env["CHRO_LIVE_WINDOW_OLD"], let pin = env["CHRO_LIVE_WINDOW_PIN"],
              let searched = env["CHRO_LIVE_SEARCH_OLD"], let server = env["CHRO_LIVE_SERVER"],
              let statusTarget = env["CHRO_LIVE_STATUS_SESSION"]?.split(separator: "|", maxSplits: 1).map(String.init), statusTarget.count == 2
        else { throw XCTSkip("Needs the CHRO_LIVE_WINDOW_* variables") }
        launch()
        expect(text(project), "the list", timeout: 30)
        expect(text("Pinned"), "the pinned section")
        expect(containing(pin), "a pinned session")
        shot("window-01-list", settle: 2)

        // Only the project's group open: its "Show N more" is the first below it.
        button("Collapse all").tap()
        let header = text(project)
        let expand = try XCTUnwrap(sameLine(app.buttons.matching(NSPredicate(format: "label == 'Expand'")), header))
        expand.tap()
        let showMore = try XCTUnwrap(nearestBelow(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Show '")), header))
        XCTAssertTrue(showMore.label.hasSuffix(" more"), showMore.label)
        XCTAssertFalse(containing(old).exists, "the oldest session is outside the window")
        shot("window-02-project-folded", settle: 1)
        showMore.tap()
        expect(containing(old), "the next page from the host", timeout: 15)
        shot("window-03-show-more", settle: 1)

        // Search finds a session the phone does not hold, and opens it.
        button("Search").tap()
        let field = app.textFields.firstMatch
        expect(field, "the palette")
        field.tap()
        field.typeText(searched)
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "\(searched) · ")).firstMatch
        expect(row, "the host's search result", timeout: 15)
        shot("window-04-search", settle: 0.5)
        row.tap()
        expect(button("Open right panel"), "the conversation of the found session", timeout: 15)
        expect(containing(searched), "the found session's title")
        shot("window-05-found-session", settle: 2)
        button("Back").tap()

        // Home's Recent.
        expect(text(project), "back on the list")
        text(project).tap()
        expect(text("Recent"), "Home's Recent")
        shot("window-06-home-recent", settle: 1.5)
        button("Back").tap()

        // Archive and restore on the desktop.
        let (statusID, statusTitle) = (statusTarget[0], statusTarget[1])
        expect(containing(statusTitle), "the session before archiving")
        setStatus(server, statusID, "cancelled")
        let gone = NSPredicate(format: "exists == false")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: gone, object: containing(statusTitle))], timeout: 15), .completed,
                       "an archived session leaves the list")
        shot("window-07-archived-on-desktop", settle: 0.5)
        setStatus(server, statusID, "pending")
        expect(containing(statusTitle), "a restored session returns", timeout: 15)
        shot("window-08-restored-on-desktop", settle: 0.5)
    }

    /// `docs/report/index.html` of `CHRO_LIVE_PROJECT` (a stylesheet with a web font, an
    /// image and a script beside it; the script writes what loaded): the page renders from
    /// the desktop's asset endpoint over the link, a link to a note opens it in chro, Raw
    /// shows the source, and a web link leaves for the system browser.
    func test19HtmlPreviewOfARealFile() {
        openHome()
        button("Open right panel").tap()
        expect(button("Files"), "the dock")
        button("Files").tap()
        for name in ["docs", "report", "index.html"] {
            expect(row(name), name)
            row(name).tap()
        }
        let page = app.webViews.firstMatch
        expect(page.staticTexts["Script ran. Stylesheet applied. Font loaded. Image loaded."], "the page with all its resources", timeout: 30)
        shot("phone-html-preview", settle: 1.5)
        button("Fullscreen preview").tap()
        expect(button("Exit fullscreen"), "fullscreen")
        shot("phone-html-fullscreen", settle: 1)
        button("Exit fullscreen").tap()

        page.links["Restock notes"].tap()
        expect(app.textFields["Document title"], "the linked note in chro")
        shot("phone-html-link-local", settle: 1.5)
        button("Back").tap()

        expect(button("Raw"), "the toolbar")
        button("Raw").tap()
        expect(app.textViews["code-editor"], "the source")
        shot("phone-html-raw", settle: 1.5)
        button("Preview").tap()
        expect(page.links["Supplier form"], "the page again", timeout: 30)
        page.links["Supplier form"].tap()
        XCTAssertTrue(XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").wait(for: .runningForeground, timeout: 15))
        app.activate()
    }
}
