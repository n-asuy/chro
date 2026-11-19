import XCTest

/// The file screen and its viewers on the fixture services (mock slots 10 and 22).
@MainActor
final class DockEditorUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func launch(_ screen: String) {
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard", "-ChroScreen", screen]
        app.launch()
    }

    private func button(_ label: String) -> XCUIElement { SettledElement.wait(app.buttons[label].firstMatch) }
    private func text(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }
    private func containing(_ fragment: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch
    }
    private func row(_ name: String) -> XCUIElement { app.descendants(matching: .any)["tree:\(name)"].firstMatch }

    /// Keeps a screenshot of the state in the result bundle, for comparison with the mock.
    private func attachScreen(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Home → the dock's Files → a file of the main checkout.
    private func openProjectFile(_ path: [String]) {
        launch("dock-search")
        XCTAssertTrue(button("Files").waitForExistence(timeout: 5))
        button("Files").tap()
        for name in path {
            XCTAssertTrue(row(name).waitForExistence(timeout: 3), name)
            row(name).tap()
        }
    }

    // MARK: Code (slot 10)

    func testCodeFileShowsTheChangesToggleAndFindsInTheFile() {
        launch("file")
        let editor = app.textViews["code-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String)?.contains("export function removeStock") == true)
        XCTAssertTrue(text("/src/stock.ts").exists)
        let changes = button("Show changes against the base version")
        XCTAssertTrue(changes.exists)
        changes.tap()
        XCTAssertTrue(button("Back to the editor").waitForExistence(timeout: 3))
        XCTAssertFalse(editor.exists, "the split diff replaces the editor")
        button("Back to the editor").tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 3))

        button("Find in file").tap()
        let field = app.textFields["Find in file"]
        XCTAssertTrue(field.waitForExistence(timeout: 2))
        field.typeText("items")
        XCTAssertTrue(text("1/4").waitForExistence(timeout: 2))
        button("Next match").tap()
        XCTAssertTrue(text("2/4").waitForExistence(timeout: 2))
        button("Previous match").tap()
        button("Previous match").tap()
        XCTAssertTrue(text("4/4").waitForExistence(timeout: 2))
        button("Close find bar").tap()
        XCTAssertFalse(field.waitForExistence(timeout: 1))
    }

    func testTypingInCodeSavesAndMarksTheLineChanged() {
        launch("file")
        let editor = app.textViews["code-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        XCTAssertTrue(button("Undo").waitForExistence(timeout: 3), "the keyboard bar shows while editing")
        app.typeText("// note\n")
        XCTAssertTrue((editor.value as? String)?.contains("// note") == true)
        button("Undo").tap()
        button("Done").tap()
        XCTAssertFalse(button("Undo").waitForExistence(timeout: 1))
    }

    func testSavingKeepsTheGutterInView() {
        // Found on a real server: after typing and Done, the code scrolled sideways by the
        // gutter's width, so the line numbers and change bars were off screen.
        launch("file")
        let editor = app.textViews["code-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        let start = editor.frame.minX
        editor.tap()
        XCTAssertTrue(button("Done").waitForExistence(timeout: 3))
        app.typeText("// note\n")
        button("Done").tap()
        XCTAssertFalse(button("Undo").waitForExistence(timeout: 1))
        XCTAssertEqual(editor.frame.minX, start, accuracy: 1, "the code did not scroll sideways")
    }

    // MARK: Prose (slot 22)

    func testProseRendersMarkdownAndEditsALineAsSource() {
        launch("file-editing")
        XCTAssertTrue(text("inventory-service").waitForExistence(timeout: 5))
        XCTAssertTrue(text("Usage").exists)
        XCTAssertTrue(button("Add property").exists)
        let line = text("Tracks on-hand and reserved stock for every SKU.")
        XCTAssertTrue(line.exists)
        line.tap()
        let field = app.textViews["prose-line"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        XCTAssertEqual(field.value as? String, "Tracks on-hand and reserved stock for every SKU.")
        app.typeText(" Updated")
        button("Done").tap()
        XCTAssertTrue(text("Tracks on-hand and reserved stock for every SKU. Updated").waitForExistence(timeout: 3))
    }

    func testReturnSplitsAListItemAndContinuesTheMarker() {
        launch("file-editing")
        let item = containing("adds units.")
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.tap()
        let field = app.textViews["prose-line"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        app.typeText("\n")
        let next = app.textViews.matching(NSPredicate(format: "identifier == %@ AND value == %@", "prose-line", "- ")).firstMatch
        XCTAssertTrue(next.waitForExistence(timeout: 3), "Return continues the bullet on a new line")
        app.typeText("removeStock")
        XCTAssertEqual(app.textViews["prose-line"].value as? String, "- removeStock")
        button("Done").tap()
        XCTAssertTrue(text("removeStock").waitForExistence(timeout: 3))
    }

    func testAddingAPropertyWritesTheFrontmatter() {
        launch("file-editing")
        XCTAssertTrue(button("Add property").waitForExistence(timeout: 5))
        button("Add property").tap()
        let name = app.textFields["Property name"]
        XCTAssertTrue(name.waitForExistence(timeout: 2))
        name.typeText("owner\n")
        let value = app.textFields["owner"]
        XCTAssertTrue(value.waitForExistence(timeout: 3), "a new property opens its value for editing")
        value.typeText("warehouse\n")
        XCTAssertTrue(button("owner").waitForExistence(timeout: 3))
        XCTAssertEqual(button("owner").value as? String, "warehouse")
        button("Switch to source view").tap()
        let source = app.textViews["code-editor"]
        XCTAssertTrue(source.waitForExistence(timeout: 3))
        XCTAssertTrue((source.value as? String)?.hasPrefix("---\nowner: warehouse\n---\n# inventory-service") == true)
        button("Switch to UI view").tap()
        XCTAssertTrue(button("Add property").waitForExistence(timeout: 3))
    }

    func testTheTitleRenamesTheNote() {
        launch("file-editing")
        let title = app.textFields["Document title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.value as? String, "README")
        title.tap()
        title.press(forDuration: 1.2)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        app.typeText("Overview\n")
        XCTAssertTrue(text("Overview.md").waitForExistence(timeout: 3), "the navigation title follows the new name")
    }

    func testFrontmatterPropertiesAndTasksOfANote() {
        openProjectFile(["docs", "restock-notes.md"])
        XCTAssertTrue(text("owner").waitForExistence(timeout: 5))
        attachScreen("notes")
        XCTAssertTrue(button("reviewed").exists)
        XCTAssertEqual(button("reviewed").value as? String, "false")
        button("reviewed").tap()
        XCTAssertEqual(button("reviewed").value as? String, "true")
        XCTAssertTrue(text("restock").exists, "tags render as chips")
        let task = app.buttons.matching(NSPredicate(format: "label == %@", "Toggle task")).firstMatch
        XCTAssertTrue(task.exists)
        XCTAssertEqual(task.value as? String, "unchecked")
        task.tap()
        XCTAssertEqual(task.value as? String, "checked")
        button("Type: Text").tap()
        XCTAssertTrue(button("Number").waitForExistence(timeout: 2))
        XCTAssertTrue(button("Tags").exists)
    }

    /// Pressing a property, value included, opens its menu instead of editing the value;
    /// the delete confirmation then opens beside that property, not at the top of the screen.
    func testLongPressingAPropertyOffersToDeleteIt() {
        openProjectFile(["docs", "restock-notes.md"])
        let owner = button("owner")
        XCTAssertTrue(owner.waitForExistence(timeout: 5))
        owner.press(forDuration: 1.0)
        XCTAssertTrue(button("Delete property").waitForExistence(timeout: 3), "the row's menu")
        XCTAssertFalse(app.textFields["owner"].exists, "the value did not start editing")
        button("Delete property").tap()
        let confirm = app.buttons["Delete property"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 3), "deleting still asks first")
        XCTAssertLessThan(abs(confirm.frame.midY - owner.frame.midY), 120,
                          "the confirmation opens at the pressed property (\(confirm.frame.midY) vs \(owner.frame.midY))")
        XCTAssertTrue(text("owner").exists, "nothing is deleted before the confirmation")
        confirm.tap()
        XCTAssertFalse(text("owner").waitForExistence(timeout: 2))
    }

    // MARK: Spreadsheet, base, media, drawing

    func testSpreadsheetSelectsEditsAndAddsRows() {
        openProjectFile(["docs", "stock-levels.csv"])
        XCTAssertTrue(text("3 rows").waitForExistence(timeout: 5))
        attachScreen("csv")
        XCTAssertTrue(text("4 columns").exists)
        XCTAssertTrue(text("R1, C1").exists)
        let cell = text("on_hand: 1")
        XCTAssertTrue(cell.exists)
        cell.tap()
        XCTAssertTrue(text("R2, C2").waitForExistence(timeout: 2))
        cell.tap()
        app.typeText("\u{8}7\n")
        XCTAssertTrue(text("on_hand: 7").waitForExistence(timeout: 3))
        button("More").tap()
        XCTAssertTrue(button("+ Row").waitForExistence(timeout: 2))
        button("+ Row").tap()
        XCTAssertTrue(text("4 rows").waitForExistence(timeout: 3))
    }

    func testBaseViewFiltersSortsAndTogglesACheckbox() {
        openProjectFile(["docs", "reorder.cbase"])
        XCTAssertTrue(text("3 results").waitForExistence(timeout: 5))
        XCTAssertTrue(button("B2").exists)
        attachScreen("base")
        button("Low stock").tap()
        XCTAssertTrue(text("1 results").waitForExistence(timeout: 3))
        XCTAssertTrue(text("status is low").exists)
        button("Remove filter").tap()
        XCTAssertTrue(text("3 results").waitForExistence(timeout: 3))
        button("All SKUs").tap()
        button("Sort").tap()
        XCTAssertTrue(button("on_hand · High to low").waitForExistence(timeout: 2))
        button("on_hand · High to low").tap()
        let names = app.buttons.matching(NSPredicate(format: "label IN %@", ["A1", "B2", "C3"]))
        XCTAssertTrue(names.firstMatch.waitForExistence(timeout: 3))
        XCTAssertEqual(names.element(boundBy: 0).label, "C3")
        let reviewed = app.buttons.matching(NSPredicate(format: "label == %@ AND value == %@", "reviewed", "false")).firstMatch
        XCTAssertTrue(reviewed.exists)
        reviewed.tap()
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@ AND value == %@", "reviewed", "true")).count, 2)
    }

    func testImagePdfAndDrawingViewers() {
        openProjectFile(["docs", "stock-report.pdf"])
        XCTAssertTrue(text("2 pages").waitForExistence(timeout: 5))
        attachScreen("pdf")
        XCTAssertTrue(text("100%").exists)
        button("Zoom in").tap()
        XCTAssertTrue(text("125%").waitForExistence(timeout: 2))
        button("Rotate").tap()
    }

    func testDrawingOpensAsAStillPicture() {
        openProjectFile(["docs", "warehouse-layout.excalidraw"])
        XCTAssertTrue(app.otherElements["warehouse-layout.excalidraw"].waitForExistence(timeout: 5) || text("warehouse-layout.excalidraw").exists)
        XCTAssertFalse(text("Failed to load file").exists)
        XCTAssertFalse(text("Loading file…").exists)
        attachScreen("scene")
    }

    func testGalleryImageOpensTheZoomableViewer() {
        launch("gallery")
        let tile = app.buttons["sku-heatmap.png"].firstMatch
        XCTAssertTrue(tile.waitForExistence(timeout: 5))
        tile.tap()
        XCTAssertTrue(text("64 × 64").waitForExistence(timeout: 5))
        XCTAssertTrue(text("64 × 64 px").exists)
        attachScreen("image")
        button("Zoom in").tap()
        XCTAssertTrue(text("125%").waitForExistence(timeout: 2))
        button("Rotate").tap()
    }
}
