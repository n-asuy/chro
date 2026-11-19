import XCTest

/// An HTML file on the fixture services: the desktop's HTML toolbar, the
/// rendered page with its stylesheet, image and script served through the
/// preview's URL scheme, and the server's link bridge (bundled from
/// crates/server) forwarding clicks to the app.
@MainActor
final class DockHtmlPreviewUITests: XCTestCase {
    private var app: XCUIApplication!

    /// What the report's script writes once it ran and saw its stylesheet and image load.
    private static let loadedLine = "Script ran. Stylesheet applied. Image loaded."

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard", "-ChroScreen", "html-preview"]
        app.launch()
    }

    private func button(_ label: String) -> XCUIElement { SettledElement.wait(app.buttons[label].firstMatch) }
    private var page: XCUIElement { app.webViews.firstMatch }

    private func attachScreen(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Waits for the rendered report, which proves the document, stylesheet, image and script all came through.
    private func waitForTheRenderedReport(_ message: String = "the report renders with its resources") {
        XCTAssertTrue(page.staticTexts[Self.loadedLine].waitForExistence(timeout: 10), message)
    }

    func testOpensOnThePreviewAndRawShowsTheSource() {
        waitForTheRenderedReport()
        XCTAssertTrue(page.staticTexts["Stock report"].exists)
        XCTAssertTrue(page.images["SKU heatmap"].exists)
        XCTAssertTrue(button("Preview").isSelected)
        XCTAssertTrue(button("Refresh preview").exists)
        XCTAssertTrue(button("Fullscreen preview").exists)
        attachScreen("html-preview")

        button("Raw").tap()
        let editor = app.textViews["code-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String)?.hasPrefix("<!doctype html>") == true)
        XCTAssertTrue(button("Raw").isSelected)
        XCTAssertFalse(app.buttons["Refresh preview"].exists, "refresh and fullscreen belong to the preview")
        XCTAssertFalse(app.buttons["Fullscreen preview"].exists)
        XCTAssertTrue(button("Find in file").exists, "the raw source is the code layout")
        attachScreen("html-raw")

        button("Preview").tap()
        waitForTheRenderedReport("switching back loads the page again")
    }

    func testFullscreenGivesThePageTheScreenAndExits() {
        waitForTheRenderedReport()
        XCTAssertTrue(button("Back").exists)
        button("Fullscreen preview").tap()
        XCTAssertTrue(button("Exit fullscreen").waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Back"].exists, "the navigation bar gives way to the page")
        XCTAssertTrue(page.staticTexts[Self.loadedLine].exists, "the page stays loaded")
        attachScreen("html-fullscreen")
        button("Exit fullscreen").tap()
        XCTAssertTrue(button("Back").waitForExistence(timeout: 3))
        XCTAssertTrue(button("Fullscreen preview").exists)
    }

    func testRefreshShowsWhatIsOnDisk() {
        waitForTheRenderedReport()
        button("Raw").tap()
        let editor = app.textViews["code-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        // Below the last line puts the caret at the end; content after `</html>` still lands in the body.
        editor.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
        editor.typeText("\n<p>Edited on the phone</p>")
        button("Preview").tap()
        XCTAssertTrue(page.staticTexts["Edited on the phone"].waitForExistence(timeout: 10), "Preview saves pending edits before it loads")
    }

    func testALocalLinkOpensTheFileInChro() {
        waitForTheRenderedReport()
        page.links["Restock notes"].tap()
        let title = app.textFields["Document title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5), "the note opens in the prose layout")
        XCTAssertEqual(title.value as? String, "restock-notes")
        attachScreen("html-link-local")
        button("Back").tap()
        waitForTheRenderedReport("back returns to the preview")
    }

    func testAnExternalLinkGoesToTheSystemBrowser() {
        waitForTheRenderedReport()
        page.links["Supplier form"].tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 10), "the web page opens outside chro")
        app.activate()
        waitForTheRenderedReport("the preview did not navigate away")
    }
}
