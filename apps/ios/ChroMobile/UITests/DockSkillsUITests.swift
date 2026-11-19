import XCTest

/// Mock slot 16: the Skills screen of inventory-service on the fixture services.
@MainActor
final class DockSkillsUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard", "-ChroScreen", "skills"]
        app.launch()
    }

    private func text(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    func testListsWorkspaceAndUserSkillsWithCounts() {
        XCTAssertTrue(text("restock-check").waitForExistence(timeout: 5))
        for label in ["agent-browser", "agents-sdk", "Workspace 1", "User 3", "Claude 4"] {
            XCTAssertTrue(text(label).exists, label)
        }
        // Only providers present get a chip.
        XCTAssertFalse(text("Codex 0").exists)
    }

    func testScopeFilterNarrowsTheCards() {
        XCTAssertTrue(text("restock-check").waitForExistence(timeout: 5))
        app.buttons["User 3"].tap()
        XCTAssertTrue(text("restock-check").waitForNonExistence(timeout: 2))
        XCTAssertTrue(text("agent-browser").exists)
        app.buttons["Workspace 1"].tap()
        XCTAssertTrue(text("restock-check").waitForExistence(timeout: 2))
        XCTAssertFalse(text("agent-browser").exists)
    }

    func testSearchMatchesDescriptionsAndShowsTheEmptyState() {
        let field = app.textFields["Search skills"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("reorder")
        XCTAssertTrue(text("restock-check").waitForExistence(timeout: 2))
        XCTAssertFalse(text("agents-sdk").exists)
        field.typeText("zzz")
        XCTAssertTrue(text("No matching skills").waitForExistence(timeout: 2))
    }

    func testAWorkspaceSkillUnderADotFolderIsNotOfferedAsATap() {
        XCTAssertTrue(text("restock-check").waitForExistence(timeout: 5))
        // Hidden entries are off, so the tree cannot show .claude/skills: no reveal button.
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "restock-check")).count, 0)
    }
}
