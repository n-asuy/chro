import Foundation

/// The two themes the desktop's tokens are defined for.
public enum ThemeMode: Sendable, CaseIterable { case light, dark }

/// An sRGB colour with 0...1 channels.
public struct RGBColor: Equatable, Sendable {
    public var red: Double
    public var green: Double
    public var blue: Double

    public init(red: Double, green: Double, blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    /// `0xRRGGBB`.
    public init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    /// CSS `hsl(h s% l%)`, as globals.css writes its shadcn tokens.
    public init(hue: Double, saturation: Double, lightness: Double) {
        let s = saturation / 100, l = lightness / 100
        func channel(_ n: Double) -> Double {
            let k = (n + hue / 30).truncatingRemainder(dividingBy: 12)
            return l - s * min(l, 1 - l) * max(-1, min(k - 3, 9 - k, 1))
        }
        self.init(red: channel(0), green: channel(8), blue: channel(4))
    }

    /// `#rrggbb`, channels rounded and clamped to 0...255.
    public var hex: String {
        let channels = [red, green, blue].map { min(255, max(0, Int(($0 * 255).rounded()))) }
        return "#" + channels.map { String(format: "%02x", $0) }.joined()
    }

    /// This colour drawn at `opacity` over `background` (source-over).
    public func composited(over background: RGBColor, opacity: Double) -> RGBColor {
        RGBColor(red: red * opacity + background.red * (1 - opacity),
                 green: green * opacity + background.green * (1 - opacity),
                 blue: blue * opacity + background.blue * (1 - opacity))
    }

    /// WCAG 2.x contrast ratio on 8-bit channels (settings/lib/contrast.ts).
    public func contrast(with other: RGBColor) -> Double {
        let a = relativeLuminance, b = other.relativeLuminance
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    private var relativeLuminance: Double {
        func channel(_ value: Double) -> Double {
            let c = Double(min(255, max(0, Int((value * 255).rounded())))) / 255
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    }
}

/// A token's value in each theme.
public struct ThemedColor: Equatable, Sendable {
    public let light: RGBColor
    public let dark: RGBColor

    public init(light: RGBColor, dark: RGBColor) {
        self.light = light
        self.dark = dark
    }

    public init(light: UInt32, dark: UInt32) {
        self.init(light: RGBColor(hex: light), dark: RGBColor(hex: dark))
    }

    /// One value in both themes.
    public init(_ both: UInt32) {
        self.init(light: both, dark: both)
    }

    public subscript(mode: ThemeMode) -> RGBColor { mode == .light ? light : dark }
}

/// The desktop's colour tokens (apps/desktop/src/app/globals.css) the phone
/// draws with. The app's `Palette` turns each into a dynamic colour; keeping
/// the values here lets their contrast be checked without a simulator.
public enum ColorTokens {
    // Text steps (--color-text-100…400).
    public static let text100 = ThemedColor(light: 0x17181B, dark: 0xDFE1E5)
    public static let text200 = ThemedColor(light: 0x3D4046, dark: 0xA9ADB5)
    public static let text300 = ThemedColor(light: 0x62666E, dark: 0x7C818A)
    public static let text400 = ThemedColor(light: 0x9BA1AA, dark: 0x595E67)

    // Surfaces (--color-background-100/90/80) and borders.
    public static let background = ThemedColor(light: 0xFFFFFF, dark: 0x1C1D21)
    public static let background90 = ThemedColor(light: 0xF6F7F9, dark: 0x202126)
    public static let background80 = ThemedColor(light: 0xEEF0F3, dark: 0x26272C)
    /// `--muted`: hover and selected fills, tag chips.
    public static let muted = ThemedColor(light: 0xF1F2F5, dark: 0x26272C)
    /// `--color-border-200`.
    public static let border = ThemedColor(light: 0xE6E8EC, dark: 0x2B2C32)
    /// `--color-border-400`: the sheet grabber.
    public static let strongBorder = ThemedColor(light: 0xD1D4DA, dark: 0x3F414A)

    // Accent.
    /// `--primary`.
    public static let primary = ThemedColor(light: 0x0C6CBE, dark: 0x4AA3EC)
    /// `--primary-foreground`: text and glyphs on a `primary` fill.
    public static let primaryForeground = ThemedColor(light: RGBColor(hue: 0, saturation: 0, lightness: 100),
                                                      dark: RGBColor(hue: 201.4, saturation: 38.9, lightness: 7.1))
    /// The toast card under white text (globals.css dark `--color-toast-*-background`).
    public static let toast = ThemedColor(light: 0x17181B, dark: 0x2E2E2E)
    /// `--destructive`.
    public static let destructive = ThemedColor(light: 0xD34049, dark: 0xE0555D)

    // A disabled control: a quiet surface with tertiary text, not a faded call to action.
    public static let disabledFill = background80
    public static let disabledForeground = text300

    // Code and diffs. Light keeps the approved mock's colours; dark is the
    // desktop diff viewer's dark theme, so code stays readable on dark surfaces.
    public static func syntax(_ kind: SyntaxTokens.Kind) -> ThemedColor {
        switch kind {
        case .plain: return text100
        case .keyword: return ThemedColor(light: 0x8A3AB9, dark: 0xFF7B72)
        case .function: return ThemedColor(light: 0x1D4ED8, dark: 0xD2A8FF)
        case .type: return ThemedColor(light: 0x15803D, dark: 0xFFA657)
        case .string: return ThemedColor(light: 0xC2410C, dark: 0xA5D6FF)
        case .comment: return ThemedColor(light: 0x62666E, dark: 0x8B949E)
        }
    }

    /// green-600 and rose-600, drawn as tints behind changed lines.
    public static let diffAdded = ThemedColor(0x16A34A)
    public static let diffRemoved = ThemedColor(0xE11D48)
    public static let diffLineOpacity = 0.15
    public static let diffNumberOpacity = 0.2
    /// The `+N` / `-N` counts: emerald/rose 600 in light, 400 in dark.
    public static let diffAdditionText = ThemedColor(light: 0x059669, dark: 0x34D399)
    public static let diffDeletionText = ThemedColor(light: 0xE11D48, dark: 0xFB7185)
}
