import XCTest

/// A bottom sheet rises as one piece: whatever its body shows (loaded rows,
/// a footer, a spinner) travels with its header, so nothing is drawn at its
/// resting place before the sheet gets there. The motion is slowed down
/// (`-ChroMotionScale`) and one accessibility snapshot is read mid-flight, so
/// every frame compared comes from the same instant.
@MainActor
final class SheetMotionUITests: XCTestCase {
    private var app: XCUIApplication!
    private static let slowdown = "25"

    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func launch(_ arguments: [String]) {
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard", "-ChroMotionScale", Self.slowdown] + arguments
        app.launch()
    }

    private func text(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    func testDockBodyAndFooterRiseWithTheHeader() throws {
        launch(["-ChroScreen", "session", "-ChroFocus", "7a3f5d10-add"])
        // The branch chip opens the dock on Source Control whatever panel was last shown.
        let open = app.buttons["Open Source Control"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.tap()
        try assertRisesAsOnePiece(header: "Done", body: ["All changes", "Merge into main"])
    }

    func testAgentStatusRowsRiseWithTheHeader() throws {
        launch(["-ChroScreen", "list"])
        let open = app.buttons["Agent status"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.tap()
        // Refresh (its spinner while probing) shares the header row.
        try assertRisesAsOnePiece(header: "Done", body: ["Refresh", "Copy command"])
    }

    func testPaletteRowsRiseWithTheSearchField() throws {
        launch(["-ChroScreen", "list"])
        let open = app.buttons["Search"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.tap()
        try assertRisesAsOnePiece(header: "Done", body: ["Commands", "Recent"])
    }

    /// A row's long press is the system context menu; the list's sheet with a
    /// title and rows is "Open another project".
    func testOpenProjectRowsRiseWithTheirTitle() throws {
        launch(["-ChroScreen", "list"])
        let open = app.buttons["Open another project"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.tap()
        try assertRisesAsOnePiece(header: "Done", body: ["New workspace"])
    }

    /// Closing a sheet whose search field has the keyboard lowers the keyboard
    /// with the sheet, not after the (slowed) sheet has left the screen.
    func testClosingAPickerLowersTheKeyboardWithIt() {
        launch(["-ChroScreen", "home"])
        let plus = app.buttons["Add context"]
        XCTAssertTrue(plus.waitForExistence(timeout: 5))
        plus.tap()
        let files = app.buttons["Files & Folders"]
        XCTAssertTrue(files.waitForExistence(timeout: 30))
        Thread.sleep(forTimeInterval: 12)  // the slowed rise settles
        files.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 30), "the picker's search field takes the keyboard")
        // The scrim above the tall sheet closes it.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.076)).tap()
        // The slowed fall takes about 15 seconds; the keyboard leaves at once.
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3), "the keyboard goes down with the sheet")
        XCTAssertTrue(app.textFields["Search"].exists, "the sheet is still on its way down")
    }

    /// Mid-flight, the header is still below its resting place and every body
    /// element is displaced by the same distance, none of them above the header.
    private func assertRisesAsOnePiece(header: String, body: [String], file: StaticString = #filePath, line: UInt = #line) throws {
        // Early in the slowed rise: the sheet is on screen and still travelling.
        Thread.sleep(forTimeInterval: 1.2)
        let moving = try frames(of: [header] + body)
        let resting = try settledFrames(of: [header] + body)

        let headerTravel = moving[header]!.minY - resting[header]!.minY
        XCTAssertGreaterThan(headerTravel, 30, "the sheet is still rising when sampled", file: file, line: line)
        for label in body {
            let travel = moving[label]!.minY - resting[label]!.minY
            XCTAssertEqual(travel, headerTravel, accuracy: 1.5,
                           "\(label) travels with the header (it moved \(travel), the header \(headerTravel))", file: file, line: line)
            XCTAssertGreaterThanOrEqual(moving[label]!.minY, moving[header]!.minY - 1, "\(label) is not above the header", file: file, line: line)
        }
    }

    /// Frames of the first element with each label, read from one snapshot.
    private func frames(of labels: [String], file: StaticString = #filePath, line: UInt = #line) throws -> [String: CGRect] {
        let snapshot = try app.snapshot()
        var found: [String: CGRect] = [:]
        var stack = [snapshot]
        while let node = stack.popLast() {
            if labels.contains(node.label), found[node.label] == nil, node.frame.height > 0 { found[node.label] = node.frame }
            stack.append(contentsOf: node.children.reversed())
        }
        for label in labels where found[label] == nil { XCTFail("no \(label) in the sheet", file: file, line: line) }
        return found
    }

    /// Frames once the sheet has stopped moving.
    private func settledFrames(of labels: [String]) throws -> [String: CGRect] {
        var last = try frames(of: labels)
        let deadline = Date().addingTimeInterval(40)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
            let now = try frames(of: labels)
            if now == last { return now }
            last = now
        }
        XCTFail("the sheet never settled")
        return last
    }
}
