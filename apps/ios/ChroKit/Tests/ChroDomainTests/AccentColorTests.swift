import ChroDomain
import Testing

@Suite struct AccentColorTests {
    /// Reference values computed with the desktop's derivation (culori 4, accent-derivation.ts baseFor).
    @Test(arguments: [
        ("#0c6cbe", AccentColor.Mode.light, "#0c6cbe"),
        ("#0c6cbe", .dark, "#3489dd"),
        ("#ff0000", .light, "#fb0000"),
        ("#ff0000", .dark, "#ff0000"),
        ("#808080", .light, "#6c839b"),
        ("#808080", .dark, "#7289a1"),
        ("#ffff00", .light, "#8c8c00"),
        ("#ffff00", .dark, "#cdcd00"),
        ("#10b981", .light, "#009f6d"),
        ("#10b981", .dark, "#10b981"),
    ])
    func primaryMatchesTheDesktop(seed: String, mode: AccentColor.Mode, expected: String) throws {
        let accent = try #require(AccentColor(hex: seed))
        #expect(accent.primary(mode).hex == expected)
    }

    @Test func foregroundPicksTheHigherContrast() throws {
        #expect(try #require(AccentColor(hex: "#0c6cbe")).foreground(.light).hex == "#ffffff")
        #expect(try #require(AccentColor(hex: "#ffff00")).foreground(.dark).hex == "#0b0f14")
    }

    @Test func rejectsMalformedHex() {
        #expect(AccentColor(hex: "0c6cbe") != nil)
        #expect(AccentColor(hex: "#0c6cb") == nil)
        #expect(AccentColor(hex: "#zzzzzz") == nil)
    }
}
