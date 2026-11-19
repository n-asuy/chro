import ChroDomain
import XCTest

/// The phone's colour tokens are the desktop's (apps/desktop/src/app/globals.css),
/// and every text-on-surface pair the shared controls draw stays readable in
/// both themes. Ratios are WCAG 2.x contrast on 8-bit channels.
final class ColorTokensTests: XCTestCase {
    private let modes: [ThemeMode] = [.light, .dark]

    // MARK: - Desktop values

    func testPrimaryForegroundIsTheDesktopToken() {
        // :root --primary-foreground: 0 0% 100%; dark: 201.4 38.9% 7.1%.
        XCTAssertEqual(ColorTokens.primaryForeground.light.hex, ChroDomain.RGBColor(hue: 0, saturation: 0, lightness: 100).hex)
        XCTAssertEqual(ColorTokens.primaryForeground.dark.hex, ChroDomain.RGBColor(hue: 201.4, saturation: 38.9, lightness: 7.1).hex)
    }

    func testHSLConversionMatchesCSS() {
        // hsl(207.6 88.1% 39.6%) is the desktop's light --primary, #0c6cbe.
        XCTAssertEqual(ChroDomain.RGBColor(hue: 207.6, saturation: 88.1, lightness: 39.6).hex, "#0c6cbe")
        XCTAssertEqual(ChroDomain.RGBColor(hue: 201.4, saturation: 38.9, lightness: 7.1).hex, "#0b1419")
    }

    func testSurfaceAndTextStepsAreTheDesktopRamps() {
        XCTAssertEqual(ColorTokens.background.light.hex, "#ffffff")
        XCTAssertEqual(ColorTokens.background.dark.hex, "#1c1d21")
        XCTAssertEqual(ColorTokens.text100.dark.hex, "#dfe1e5")
        XCTAssertEqual(ColorTokens.text300.light.hex, "#62666e")
        XCTAssertEqual(ColorTokens.primary.light.hex, "#0c6cbe")
        XCTAssertEqual(ColorTokens.primary.dark.hex, "#4aa3ec")
    }

    func testDarkSyntaxIsTheDesktopDiffViewerTheme() {
        // The desktop diff viewer's dark syntax colours (keyword, entity, variable, string, comment).
        XCTAssertEqual(ColorTokens.syntax(.keyword).dark.hex, "#ff7b72")
        XCTAssertEqual(ColorTokens.syntax(.function).dark.hex, "#d2a8ff")
        XCTAssertEqual(ColorTokens.syntax(.type).dark.hex, "#ffa657")
        XCTAssertEqual(ColorTokens.syntax(.string).dark.hex, "#a5d6ff")
        XCTAssertEqual(ColorTokens.syntax(.comment).dark.hex, "#8b949e")
    }

    // MARK: - Contrast

    func testWhiteOnDarkPrimaryIsWhatTheAuditFlagged() {
        let white = ChroDomain.RGBColor(red: 1, green: 1, blue: 1)
        XCTAssertLessThan(white.contrast(with: ColorTokens.primary.dark), 3)
    }

    func testPrimaryButtonLabelIsReadableInBothThemes() {
        for mode in modes {
            let ratio = ColorTokens.primaryForeground[mode].contrast(with: ColorTokens.primary[mode])
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(mode) primary button label: \(ratio)")
        }
    }

    func testDisabledButtonLabelStaysReadable() {
        // A disabled control changes colour instead of fading the whole button.
        for mode in modes {
            let ratio = ColorTokens.disabledForeground[mode].contrast(with: ColorTokens.disabledFill[mode])
            XCTAssertGreaterThanOrEqual(ratio, 3, "\(mode) disabled label: \(ratio)")
            let fill = ColorTokens.disabledFill[mode].contrast(with: ColorTokens.background[mode])
            XCTAssertLessThan(fill, 1.5, "\(mode) disabled fill reads as a quiet surface, not a call to action")
        }
    }

    func testTextStepsAreReadableOnEverySurface() {
        let surfaces = [ColorTokens.background, ColorTokens.background90, ColorTokens.background80]
        for mode in modes {
            for surface in surfaces {
                XCTAssertGreaterThanOrEqual(ColorTokens.text100[mode].contrast(with: surface[mode]), 7)
                XCTAssertGreaterThanOrEqual(ColorTokens.text200[mode].contrast(with: surface[mode]), 4.5)
                XCTAssertGreaterThanOrEqual(ColorTokens.text300[mode].contrast(with: surface[mode]), 3.5)
            }
        }
    }

    func testSyntaxColoursAreReadableOnCode() {
        let kinds: [SyntaxTokens.Kind] = [.plain, .keyword, .function, .type, .string, .comment]
        for mode in modes {
            for kind in kinds {
                let ratio = ColorTokens.syntax(kind)[mode].contrast(with: ColorTokens.background[mode])
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(mode) \(kind): \(ratio)")
            }
        }
    }

    func testDarkSyntaxStaysReadableOnChangedLines() {
        let background = ColorTokens.background.dark
        let tints = [ColorTokens.diffAdded.dark.composited(over: background, opacity: ColorTokens.diffLineOpacity),
                     ColorTokens.diffRemoved.dark.composited(over: background, opacity: ColorTokens.diffLineOpacity)]
        for tint in tints {
            for kind in [SyntaxTokens.Kind.plain, .keyword, .function, .type, .string, .comment] {
                let ratio = ColorTokens.syntax(kind).dark.contrast(with: tint)
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "dark \(kind) on \(tint.hex): \(ratio)")
            }
        }
    }

    func testDiffCountsAreReadable() {
        for mode in modes {
            XCTAssertGreaterThanOrEqual(ColorTokens.diffAdditionText[mode].contrast(with: ColorTokens.background[mode]), 3)
            XCTAssertGreaterThanOrEqual(ColorTokens.diffDeletionText[mode].contrast(with: ColorTokens.background[mode]), 3)
        }
    }

    func testCompositingMatchesSourceOver() {
        let black = ChroDomain.RGBColor(red: 0, green: 0, blue: 0), white = ChroDomain.RGBColor(red: 1, green: 1, blue: 1)
        XCTAssertEqual(white.composited(over: black, opacity: 0.5).hex, "#808080")
        XCTAssertEqual(white.composited(over: black, opacity: 1).hex, "#ffffff")
    }
}
