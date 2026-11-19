import XCTest

/// The right dock's Files and Agent panels on the fixture services.
@MainActor
final class DockFilesUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func launch(_ screen: String) {
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard", "-ChroScreen", screen]
        app.launch()
    }

    private func row(_ name: String) -> XCUIElement { app.descendants(matching: .any)["tree:\(name)"].firstMatch }
    private func button(_ label: String) -> XCUIElement { SettledElement.wait(app.buttons[label].firstMatch) }
    private func text(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// Opens the dock on Home (project scope) and switches to Files.
    private func openProjectFiles() {
        launch("dock-search")
        XCTAssertTrue(button("Files").waitForExistence(timeout: 5))
        button("Files").tap()
        XCTAssertTrue(row("inventory-service").waitForExistence(timeout: 3))
    }

    func testSessionTreeShowsChangedThenAllFiles() {
        launch("dock-files")
        XCTAssertTrue(row("stock.test.ts").waitForExistence(timeout: 5))
        XCTAssertTrue(row("README.md").exists)
        XCTAssertTrue(button("Open gallery").exists)
        XCTAssertFalse(button("New file").exists, "a session's worktree is read-only")
        button("All files").tap()
        XCTAssertTrue(row(".git").waitForExistence(timeout: 3))
        XCTAssertFalse(row("stock.ts").exists, "only the root is expanded in All files")
        row("src").tap()
        XCTAssertTrue(row("stock.ts").waitForExistence(timeout: 2))
        button("Collapse all").tap()
        XCTAssertFalse(row("stock.ts").waitForExistence(timeout: 1))
    }

    func testProjectTreeExpandsFoldersAndCreatesAFolderWithInlineRename() {
        openProjectFiles()
        row("docs").tap()
        XCTAssertTrue(row("restock-notes.md").waitForExistence(timeout: 2))
        button("New folder").tap()
        let field = app.textFields["Rename"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        XCTAssertEqual(field.value as? String, "New folder")
        app.typeText("orders\n")
        XCTAssertTrue(row("orders").waitForExistence(timeout: 3))
    }

    func testLongPressDuplicatesMovesAndDeletes() {
        openProjectFiles()
        row("README.md").press(forDuration: 0.8)
        XCTAssertTrue(button("Duplicate").waitForExistence(timeout: 3))
        XCTAssertTrue(button("Copy Full Path").exists)
        button("Duplicate").tap()
        XCTAssertTrue(row("README copy.md").waitForExistence(timeout: 3))

        row("README copy.md").press(forDuration: 0.8)
        button("Move to…").tap()
        XCTAssertTrue(text("Choose a destination folder in this project.").waitForExistence(timeout: 3))
        button("docs/skus").tap()
        button("Move").tap()
        XCTAssertTrue(row("skus").waitForExistence(timeout: 3))
        XCTAssertTrue(row("README copy.md").waitForExistence(timeout: 3), "the moved file is revealed in its new folder")

        row("README copy.md").press(forDuration: 0.8)
        button("Delete").tap()
        let confirm = app.sheets.buttons["Delete"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 3))
        XCTAssertTrue(text("Delete README copy.md?").exists)
        confirm.tap()
        XCTAssertFalse(row("README copy.md").waitForExistence(timeout: 1))
    }

    func testNewFileSheetCreatesAMarkdownFile() {
        openProjectFiles()
        button("New file").tap()
        XCTAssertTrue(button("Excalidraw").waitForExistence(timeout: 3))
        button("Markdown").tap()
        let field = app.textFields["Rename"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        XCTAssertEqual(field.value as? String, "New file.md")
        app.typeText("\n")

        XCTAssertTrue(row("New file.md").waitForExistence(timeout: 3))
    }

    func testAgentPanelFollowsTheFolderPickedInFiles() {
        openProjectFiles()
        button("Agent").tap()
        XCTAssertTrue(text("Select a directory in Files").waitForExistence(timeout: 2))
        button("Files").tap()
        row("docs").tap()
        button("Agent").tap()
        XCTAssertTrue(text("inventory-service / docs").waitForExistence(timeout: 3))
        XCTAssertTrue(text("No instructions file").exists)
        XCTAssertTrue(text("No history yet").exists)
        button("Files").tap()
        row("inventory-service").tap()
        button("Agent").tap()
        XCTAssertTrue(text("Summarize stock module").waitForExistence(timeout: 3))
        XCTAssertTrue(button("New session here").exists)
    }
}
