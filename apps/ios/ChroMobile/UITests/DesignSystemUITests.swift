import XCTest

/// The shared design system as the screens use it: text follows Dynamic
/// Type, every control keeps a 44pt hit area, every sheet opens with the same
/// header (title on the left, Done on the right), and the list's short menus
/// are the system's menus.
@MainActor
final class DesignSystemUITests: XCTestCase {
    private var app: XCUIApplication!
    /// The default text size (Large), whatever the simulator is set to.
    private static let defaultSize = "UICTContentSizeCategoryL"

    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func launch(_ arguments: [String], contentSize: String? = nil) {
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard"] + arguments
            + (contentSize.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? [])
        app.launch()
    }

    private func text(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func button(_ label: String) -> XCUIElement { SettledElement.wait(app.buttons[label].firstMatch) }

    // MARK: - Dynamic Type

    /// The version chip hugs its text, so its width follows the text size.
    func testListTextGrowsWithDynamicType() {
        launch(["-ChroScreen", "list"], contentSize: Self.defaultSize)
        let chip = app.buttons["Release notes"]
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        let standard = chip.frame.width
        app.terminate()

        launch(["-ChroScreen", "list"], contentSize: "UICTContentSizeCategoryAccessibilityXXXL")
        let large = app.buttons["Release notes"]
        XCTAssertTrue(large.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(large.frame.width, standard * 1.5, "the chip's text follows the reader's text size")
    }

    /// A sheet's title is one line of text, so its height follows the text size.
    func testSheetTextGrowsWithDynamicType() {
        launch(["-ChroScreen", "list"], contentSize: Self.defaultSize)
        button("Open another project").tap()
        let title = sheetTitle("Open another project")
        XCTAssertTrue(title.waitForExistence(timeout: 3))
        let standard = title.frame.height
        app.terminate()

        launch(["-ChroScreen", "list"], contentSize: "UICTContentSizeCategoryAccessibilityXXXL")
        button("Open another project").tap()
        let large = sheetTitle("Open another project")
        XCTAssertTrue(large.waitForExistence(timeout: 3))
        XCTAssertGreaterThan(large.frame.height, standard * 1.6)
    }

    /// The lowest static text with this label: a sheet's title, not the
    /// same name on the screen behind it.
    private func sheetTitle(_ label: String) -> XCUIElement {
        let texts = app.staticTexts.matching(identifier: label)
        _ = texts.firstMatch.waitForExistence(timeout: 3)
        return texts.allElementsBoundByIndex.max { $0.frame.minY < $1.frame.minY } ?? texts.firstMatch
    }

    // MARK: - Hit areas

    /// Every button on a screen is at least 44×44pt.
    private func assertButtonsMeetHitArea(_ screen: String, file: StaticString = #filePath, line: UInt = #line) {
        let buttons = app.buttons.allElementsBoundByIndex.filter { $0.exists && $0.isHittable && !$0.frame.isEmpty }
        XCTAssertFalse(buttons.isEmpty, "\(screen) has buttons", file: file, line: line)
        for button in buttons {
            let frame = button.frame
            XCTAssertGreaterThanOrEqual(frame.height, 43.5, "\(screen): “\(button.label)” is \(frame.height)pt tall", file: file, line: line)
            XCTAssertGreaterThanOrEqual(frame.width, 43.5, "\(screen): “\(button.label)” is \(frame.width)pt wide", file: file, line: line)
        }
    }

    func testSkillsFiltersMeetTheHitArea() {
        launch(["-ChroScreen", "skills"])
        XCTAssertTrue(text("All").waitForExistence(timeout: 5))
        assertButtonsMeetHitArea("skills")
    }

    func testNotePropertiesMeetTheHitArea() {
        launch(["-ChroScreen", "file-editing"])
        XCTAssertTrue(text("Properties").waitForExistence(timeout: 5))
        assertButtonsMeetHitArea("file-editing")
    }

    func testListAndSheetControlsMeetTheHitArea() {
        launch(["-ChroScreen", "list"])
        XCTAssertTrue(text("Projects").waitForExistence(timeout: 5))
        assertButtonsMeetHitArea("list")
        button("Search").tap()
        XCTAssertTrue(text("Needs attention").waitForExistence(timeout: 3))
        assertButtonsMeetHitArea("palette")
    }

    // MARK: - Sheet header

    /// Title on the left, Done on the right of the same row, above everything else.
    private func assertSheetHeader(title: String, below: [String], file: StaticString = #filePath, line: UInt = #line) {
        let done = button("Done")
        XCTAssertTrue(done.waitForExistence(timeout: 3), file: file, line: line)
        // The topmost text with the title inside the sheet (the screen behind may show it too).
        let heading = app.staticTexts.matching(identifier: title).allElementsBoundByIndex
            .filter { $0.frame.minY > done.frame.minY - 40 }
            .min { $0.frame.minY < $1.frame.minY } ?? app.staticTexts[title]
        XCTAssertTrue(heading.waitForExistence(timeout: 3), "\(title) is the sheet's title", file: file, line: line)
        XCTAssertTrue(done.exists, file: file, line: line)
        XCTAssertEqual(heading.frame.midY, done.frame.midY, accuracy: 4, "\(title) and Done share the header row", file: file, line: line)
        XCTAssertLessThan(heading.frame.minX, done.frame.minX, file: file, line: line)
        XCTAssertGreaterThan(done.frame.maxX, app.frame.width - 24, "Done sits at the right edge", file: file, line: line)
        for label in below {
            let element = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR placeholderValue == %@", label, label)).firstMatch
            XCTAssertTrue(element.exists, label, file: file, line: line)
            XCTAssertGreaterThan(element.frame.minY, done.frame.maxY - 2, "\(label) is under the header", file: file, line: line)
        }
    }

    func testPaletteHasTheSheetHeader() {
        launch(["-ChroScreen", "list"])
        button("Search").tap()
        assertSheetHeader(title: "Search", below: ["Where would you like to go?"])
    }

    func testProjectSwitcherHasTheSheetHeader() {
        launch(["-ChroScreen", "home"])
        let name = button("Switch project")
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        assertSheetHeader(title: "inventory-service", below: ["Switch to project…"])
    }

    func testModelSheetHasTheSheetHeader() {
        launch(["-ChroScreen", "new-session-model"])
        XCTAssertTrue(text("Effort").waitForExistence(timeout: 5))
        let done = button("Done")
        XCTAssertTrue(done.exists, "the model sheet's root has the header")
        XCTAssertLessThan(done.frame.maxY, text("Effort").frame.minY)
    }

    // MARK: - System menus

    func testSortIsASystemMenuThatMarksTheCurrentOrder() {
        launch(["-ChroScreen", "list"])
        XCTAssertTrue(text("Projects").waitForExistence(timeout: 5))
        button("Sort").tap()
        let current = button("Recent activity")
        XCTAssertTrue(current.waitForExistence(timeout: 2))
        XCTAssertTrue(current.isSelected, "the current order carries the checkmark")
        XCTAssertFalse(app.buttons["Done"].exists, "a menu, not a bottom sheet")
    }

    func testRowLongPressOpensTheContextMenu() {
        launch(["-ChroScreen", "list"])
        let row = text("Add stock report images")
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.press(forDuration: 0.8)
        XCTAssertTrue(button("Pin").waitForExistence(timeout: 2))
        XCTAssertFalse(app.buttons["Done"].exists, "a context menu, not a bottom sheet")
    }
}
