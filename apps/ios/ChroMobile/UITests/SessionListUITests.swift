import XCTest

/// Taps during a sheet's spring animation can miss (observed on the model
/// sheet), so wait until the element stops moving before using it.
enum SettledElement {
    @MainActor static func wait(_ element: XCUIElement) -> XCUIElement {
        guard element.waitForExistence(timeout: 0.6) else { return element }
        var last = element.frame
        for _ in 0..<10 {
            Thread.sleep(forTimeInterval: 0.08)
            let now = element.frame
            if now == last { break }
            last = now
        }
        return element
    }
}

/// Drives the app on the fixture services (the mock's captured workspace).
@MainActor
final class SessionListUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func launch(_ fixture: String = "standard", screen: String = "list") {
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", fixture, "-ChroScreen", screen]
        app.launch()
    }

    /// Any element with this accessibility label (rows are buttons, captions are text).
    private func text(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func button(_ label: String) -> XCUIElement { SettledElement.wait(app.buttons[label].firstMatch) }

    func testListShowsTheCapturedWorkspace() {
        launch()
        XCTAssertTrue(text("Pinned").waitForExistence(timeout: 5))
        for title in ["Summarize stock module", "inventory-service", "Choose restock policy", "Reword README summary", "No chats"] {
            XCTAssertTrue(text(title).exists, title)
        }
        // Seven rows fold to five plus "Show 2 more" (the focused session is not set at launch).
        XCTAssertTrue(button("Show 2 more").exists)
        button("Show 2 more").tap()
        XCTAssertTrue(text("Review removeStock in src/stock.ts for edge cases").waitForExistence(timeout: 2))
        XCTAssertTrue(button("Show fewer").exists)
    }

    func testLongPressPinsThenArchivesAndRestores() {
        launch()
        let row = text("Add stock report images")
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.press(forDuration: 0.8)
        XCTAssertTrue(button("Pin").waitForExistence(timeout: 2))
        XCTAssertTrue(text("Continue in…").exists)
        button("Pin").tap()

        row.press(forDuration: 0.8)
        XCTAssertTrue(button("Unpin").waitForExistence(timeout: 2), "the session is pinned now")
        button("Archive").tap()
        XCTAssertFalse(text("Add stock report images").waitForExistence(timeout: 1))

        let archive = app.buttons.matching(identifier: "Archive").firstMatch
        XCTAssertTrue(archive.waitForExistence(timeout: 2), "the project offers its archive")
        archive.tap()
        XCTAssertTrue(text("Add stock report images").waitForExistence(timeout: 2))
        button("Restore session").tap()
        XCTAssertTrue(text("Add stock report images").waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons.matching(identifier: "Archive").firstMatch.waitForExistence(timeout: 1))
    }

    func testSortCollapseAndSections() {
        launch()
        XCTAssertTrue(text("Projects").waitForExistence(timeout: 5))
        button("Sort").tap()
        XCTAssertTrue(button("Name (A→Z)").waitForExistence(timeout: 2))
        button("Name (A→Z)").tap()
        XCTAssertFalse(button("Show 2 more").exists, "the waiting session sorts past the fold and only one row would hide")
        let first = text("Add removeStock to stock module")
        let later = text("Write audit marker outside repo")
        XCTAssertLessThan(first.frame.minY, later.frame.minY, "A→Z puts Add… before Write…")

        button("Collapse all").tap()
        XCTAssertFalse(text("Write audit marker outside repo").waitForExistence(timeout: 1))
        button("Collapse all").tap()
        XCTAssertTrue(text("Write audit marker outside repo").waitForExistence(timeout: 2))

        button("Pinned").tap()
        XCTAssertFalse(text("Summarize stock module").waitForExistence(timeout: 1))
        XCTAssertEqual(button("Pinned").value as? String, "Collapsed, 1", "a collapsed section reports its count")
    }

    func testDelegationFolds() {
        launch()
        button("Show 2 more").tap()
        let child = text("Review removeStock in src/stock.ts for edge cases")
        XCTAssertTrue(child.waitForExistence(timeout: 2))
        button("Hide delegated sessions").tap()
        XCTAssertFalse(child.waitForExistence(timeout: 1))
        XCTAssertTrue(button("Show 1 delegated sessions").exists)
    }

    func testPaletteSearchesSessions() {
        launch()
        button("Search").tap()
        XCTAssertTrue(text("Needs attention").waitForExistence(timeout: 2))
        let field = app.textFields.firstMatch
        field.tap()
        field.typeText("reword")
        XCTAssertTrue(text("Sessions").waitForExistence(timeout: 2))
        XCTAssertFalse(text("Needs attention").exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Reword README summary'")).firstMatch.exists)
        field.typeText("zzz")
        XCTAssertTrue(text("No matching destinations").waitForExistence(timeout: 2))
    }

    func testNewChatStartsASessionThatGetsTitled() {
        launch()
        button("New chat").tap()
        XCTAssertTrue(text("New session").waitForExistence(timeout: 2))
        XCTAssertFalse(button("From: main").exists, "a scratch chat has no git tray")
        let editor = app.textFields["Message"]
        editor.tap()
        editor.typeText("Plan the restock report. Then stop.")
        button("Send").tap()
        // Sending opens the new session; its row is on the list behind it.
        XCTAssertTrue(text("New session").waitForNonExistence(timeout: 3), "the launcher is replaced by the session")
        button("Back").tap()
        XCTAssertTrue(text("Chats").waitForExistence(timeout: 3), "back on the list")
        XCTAssertTrue(text("Plan the restock report").waitForExistence(timeout: 5), "the server titles the session")
    }

    func testHomeModelPickerAndTray() {
        launch()
        text("inventory-service").tap()
        XCTAssertTrue(text("Home").waitForExistence(timeout: 2))
        XCTAssertTrue(text("Write audit marker outside repo").exists, "Recent lists the project's sessions")
        button("Model: Claude Code").tap()
        button("Model").tap()
        XCTAssertTrue(button("Opus 5.5").waitForExistence(timeout: 2))
        button("Opus 5.5").tap()
        XCTAssertTrue(button("Model: Opus 5.5").waitForExistence(timeout: 2))
        button("Model: Opus 5.5").tap()
        button("Speed").tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Fast'")).firstMatch.tap()
        XCTAssertTrue(text("Fast").waitForExistence(timeout: 2), "the pill shows the speed")

        button("From: main").tap()
        XCTAssertTrue(text("current").waitForExistence(timeout: 2))
        button("ch/e7a6-add-removestock-to-stock").tap()
        XCTAssertTrue(button("From: ch/e7a6-add-removestock-to-stock").waitForExistence(timeout: 2))
        button("Checkout: Worktree").tap()
        button("Local").tap()
        XCTAssertTrue(button("Checkout: Local").waitForExistence(timeout: 2))

        button("Switch project").tap()
        button("Chats").tap()
        XCTAssertTrue(text("Chats").waitForExistence(timeout: 2))
    }

    func testOnboardingOpensTheFirstProject() {
        launch("fresh-host")
        XCTAssertTrue(text("Welcome to Chro").waitForExistence(timeout: 5))
        button("Get started").tap()
        XCTAssertTrue(text("Pick your coding agent").waitForExistence(timeout: 2))
        XCTAssertTrue(text("Detected · v2.1.323").waitForExistence(timeout: 3))
        button("Continue").tap()
        XCTAssertTrue(text("Pick your coding agent").exists, "Continue waits for an agent")
        app.buttons.containing(NSPredicate(format: "label CONTAINS 'Codex'")).firstMatch.tap()
        button("Continue").tap()
        XCTAssertTrue(text("Set up your agents").waitForExistence(timeout: 2))
        XCTAssertTrue(button("chro skill install").exists)
        button("Continue").tap()
        XCTAssertTrue(text("Make it feel like home").waitForExistence(timeout: 2))
        button("Light").tap()
        button("Continue").tap()
        XCTAssertTrue(text("Open your first project").waitForExistence(timeout: 2))
        XCTAssertFalse(button("Skip").exists, "the last step cannot be skipped")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Open a folder'")).firstMatch.tap()
        let repo = app.buttons.matching(NSPredicate(format: "label == 'inventory-service, Git'")).firstMatch
        XCTAssertTrue(repo.waitForExistence(timeout: 3), "a git repository carries the Git chip")
        repo.tap()
        XCTAssertTrue(text("README.md").waitForExistence(timeout: 2))
        button("Select").tap()
        XCTAssertTrue(text("Home").waitForExistence(timeout: 3), "onboarding lands on the project's Home")
    }

    func testBareHostOffersTheInstallGuide() {
        launch("bare-host", screen: "onboarding-agent")
        XCTAssertTrue(text("Pick your coding agent").waitForExistence(timeout: 5))
        XCTAssertTrue(button("Install guide").waitForExistence(timeout: 3))
        XCTAssertTrue(text("Not installed").exists)
        button("Skip").tap()
        XCTAssertTrue(text("Open a workspace").waitForExistence(timeout: 3), "skipping with nothing open shows the first-launch screen")
    }

    func testPairingByPaste() {
        launch("unpaired")
        // The simulator has no camera: the code field is the first screen.
        XCTAssertTrue(text("Paste pairing code").waitForExistence(timeout: 5))
        XCTAssertFalse(button("Scan QR code instead").exists, "nothing to scan with")
        let field = app.textFields["Pairing code"]
        field.typeText("not a code")
        button("Pair").tap()
        XCTAssertTrue(text("Not a valid pairing code — copy it from your computer and paste again").waitForExistence(timeout: 3))
        XCTAssertTrue(text("Paste pairing code").exists, "a failed paste stays on its field")
        let json = #"{"v":2,"endpoint":"ws://192.168.1.40:6768","deviceToken":"aaaa","publicKeyB64":"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg=","scope":"mobile"}"#
        let code = Data(json.utf8).base64EncodedString().replacingOccurrences(of: "=", with: "")
        let again = app.textFields["Pairing code"]
        again.tap()
        again.press(forDuration: 0.1)
        again.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12) + "chro://pair?code=\(code)")
        button("Pair").tap()
        XCTAssertTrue(text("Projects").waitForExistence(timeout: 6), "paired: the workspace opens")
    }
}
