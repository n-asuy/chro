import XCTest

/// Mock slot 15: the images run's gallery on the fixture services.
@MainActor
final class DockGalleryUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ChroFixture", "standard", "-ChroScreen", "gallery"]
        app.launch()
    }

    func testShowsTheRunsImagesNewestFirst() {
        let heatmap = app.buttons["sku-heatmap.png"]
        XCTAssertTrue(heatmap.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Gallery"].exists)
        XCTAssertTrue(app.staticTexts["3"].exists)
        let badge = app.buttons["warehouse-badge.svg"], trend = app.buttons["stock-trend.svg"]
        XCTAssertTrue(badge.exists && trend.exists)
        // Two columns: the first two tiles share a row, the third starts the next.
        XCTAssertEqual(heatmap.frame.minY, badge.frame.minY, accuracy: 1)
        XCTAssertLessThan(heatmap.frame.minX, badge.frame.minX)
        XCTAssertGreaterThan(trend.frame.minY, heatmap.frame.maxY)
        XCTAssertGreaterThanOrEqual(heatmap.frame.width, 44)
    }

    func testRefreshReloadsTheSameListing() {
        XCTAssertTrue(app.buttons["sku-heatmap.png"].waitForExistence(timeout: 5))
        app.buttons["Refresh gallery"].tap()
        XCTAssertTrue(app.buttons["sku-heatmap.png"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["3"].exists)
    }

    func testATileOpensTheFileAndBackReturns() {
        let tile = app.buttons["stock-trend.svg"]
        XCTAssertTrue(tile.waitForExistence(timeout: 5))
        tile.tap()
        XCTAssertTrue(app.buttons["Refresh gallery"].waitForNonExistence(timeout: 3))
        // The edge-swipe back gesture, independent of the file screen's own controls.
        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
        XCTAssertTrue(app.buttons["Refresh gallery"].waitForExistence(timeout: 3))
    }
}
