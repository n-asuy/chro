import XCTest

/// Settings on the fixture services (mock slot 17 and its panes).
@MainActor
final class SettingsUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard", "-ChroScreen", "settings"]
        app.launch()
    }

    private func element(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func button(_ label: String) -> XCUIElement { SettledElement.wait(app.buttons[label].firstMatch) }

    private func openPane(_ title: String) {
        XCTAssertTrue(button(title).waitForExistence(timeout: 5))
        button(title).tap()
    }

    func testPaneListOmitsDeveloperAndPushesPanes() {
        for title in ["General", "Appearance", "Workspace", "Editor", "Notifications", "MCP", "Agents"] {
            XCTAssertTrue(button(title).waitForExistence(timeout: 5), title)
        }
        XCTAssertFalse(app.buttons["Developer"].exists)
        openPane("Workspace")
        XCTAssertTrue(element("Hidden directories").waitForExistence(timeout: 3))
        button("Back").tap()
        XCTAssertTrue(button("Agents").waitForExistence(timeout: 3))
    }

    func testNotificationsDisableTheirChildren() {
        openPane("Notifications")
        let enable = app.switches["Enable Notifications"].firstMatch
        XCTAssertTrue(enable.waitForExistence(timeout: 3))
        XCTAssertEqual(enable.value as? String, "1")
        enable.tap()
        XCTAssertEqual(enable.value as? String, "0")
        XCTAssertFalse(app.switches["Agent Task Complete"].firstMatch.isEnabled)
        enable.tap()
        XCTAssertTrue(app.switches["Agent Task Complete"].firstMatch.isEnabled)
    }

    func testEditorFontSizeIsPickedFromTheList() {
        openPane("Editor")
        let size = button("Font Size")
        XCTAssertTrue(size.waitForExistence(timeout: 3))
        size.tap()
        XCTAssertTrue(button("18px").waitForExistence(timeout: 3))
        button("18px").tap()
        XCTAssertTrue(button("Font Size").waitForExistence(timeout: 3))
        XCTAssertEqual(button("Font Size").value as? String, "18px")
        button("Font Size").tap()
        button("15px").tap()
    }

    func testASaveWhoseAnswerWasLostShowsWhatTheComputerSaved() {
        // The computer saved the preference but its answer never arrived: the pane reads
        // the preference again instead of putting the old value back.
        app.terminate()
        app.launchArguments.append("-ChroLoseAnswers")
        app.launch()
        openPane("Workspace")
        let hidden = app.switches["Hidden directories"].firstMatch
        XCTAssertTrue(hidden.waitForExistence(timeout: 5))
        let before = hidden.value as? String
        let after = before == "1" ? "0" : "1"
        hidden.tap()
        // Still switched after the save settles (the old handling put the previous value back).
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertEqual(hidden.value as? String, after)
        XCTAssertFalse(element("The desktop did not answer in time.").exists)
    }

    func testThemeSwitchesToDark() {
        openPane("Appearance")
        button("Theme").tap()
        button("Dark").tap()
        XCTAssertEqual(button("Theme").value as? String, "Dark")
        button("Theme").tap()
        button("System").tap()
        XCTAssertEqual(button("Theme").value as? String, "System")
    }

    func testMcpEditorValidatesAndShowsStatus() {
        openPane("MCP")
        XCTAssertTrue(element("/Users/me/.claude.json").waitForExistence(timeout: 5))
        let save = app.buttons["Save"].firstMatch
        XCTAssertFalse(save.isEnabled)
        let editor = app.textViews["Server Configuration (JSON)"].firstMatch.exists
            ? app.textViews["Server Configuration (JSON)"].firstMatch
            : app.textFields["Server Configuration (JSON)"].firstMatch
        editor.tap()
        editor.typeText("x")
        XCTAssertTrue(element("The configuration JSON contains a syntax error.").waitForExistence(timeout: 3))
        XCTAssertFalse(save.isEnabled)
        button("Reload").tap()
        XCTAssertFalse(element("The configuration JSON contains a syntax error.").waitForExistence(timeout: 2))
        button("Check Connection").tap()
        XCTAssertTrue(element("freee").waitForExistence(timeout: 5))
        button("pi").tap()
        XCTAssertTrue(element("Connection checks are not available for pi.").waitForExistence(timeout: 3))
    }

    /// Replaces the editor's whole text.
    private func replaceEditorText(_ editor: XCUIElement, with text: String) {
        editor.tap()
        editor.press(forDuration: 1.0)
        let selectAll = app.menuItems["Select All"].firstMatch
        XCTAssertTrue(selectAll.waitForExistence(timeout: 3))
        selectAll.tap()
        editor.typeText(text)
    }

    /// Claude Code's fixture file with `token` as the hidden credential's string (compact JSON).
    private static func claudeConfig(token: String) -> String {
        #"{"mcpServers":{"actors-mcp-server":{"args":["-y","@apify/actors-mcp-server"],"command":"npx","env":{"APIFY_TOKEN":"\#(token)"}},"#
            + #""freee":{"type":"http","url":"https://mcp.freee.co.jp/mcp"},"open-pencil":{"command":"openpencil-mcp"}}}"#
    }

    func testMcpRefusesEditingAroundAHiddenCredential() {
        openPane("MCP")
        XCTAssertTrue(element("/Users/me/.claude.json").waitForExistence(timeout: 5))
        let editor = app.textViews["Server Configuration (JSON)"].firstMatch.exists
            ? app.textViews["Server Configuration (JSON)"].firstMatch
            : app.textFields["Server Configuration (JSON)"].firstMatch
        XCTAssertTrue((editor.value as? String)?.contains(#""APIFY_TOKEN": "__chro_hidden__""#) == true)
        let save = app.buttons["Save"].firstMatch
        replaceEditorText(editor, with: Self.claudeConfig(token: "prefix-__chro_hidden__"))
        let refusal = #"MCP server "actors-mcp-server" holds a hidden value that no longer matches the computer's configuration; edit hidden values on the computer, or replace the whole value"#
        XCTAssertTrue(element(refusal).waitForExistence(timeout: 3))
        XCTAssertFalse(save.isEnabled)
        // Reloading brings the hidden value back as the computer sent it.
        button("Reload").tap()
        XCTAssertFalse(element(refusal).waitForExistence(timeout: 2))
        XCTAssertTrue((editor.value as? String)?.contains(#""APIFY_TOKEN": "__chro_hidden__""#) == true)
    }

    func testAgentsListsCLIsWithoutPiCredentials() {
        openPane("Agents")
        XCTAssertTrue(element("2.1.323 (Claude Code)").waitForExistence(timeout: 5))
        XCTAssertEqual(button("Default Agent").value as? String, "Claude Code")
        app.swipeUp()
        XCTAssertTrue(element("Shell command").exists)
        XCTAssertFalse(element("pi Credentials").exists)
    }
}
