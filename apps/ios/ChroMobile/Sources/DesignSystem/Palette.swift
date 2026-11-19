import ChroDomain
import SwiftUI
import UIKit

/// The desktop's colour tokens (ChroDomain `ColorTokens`, from
/// apps/desktop/src/app/globals.css), light and dark. Names follow the mock:
/// `fg` is text-100, `t200`…`t400` the text steps, `bg80`/`bg90` the tonal
/// background steps.
enum Palette {
    static let fg = dynamic(ColorTokens.text100)
    static let t200 = dynamic(ColorTokens.text200)
    static let t300 = dynamic(ColorTokens.text300)
    static let t400 = dynamic(ColorTokens.text400)
    static let bg = dynamic(ColorTokens.background)
    static let muted = dynamic(ColorTokens.muted)
    static let bg80 = dynamic(ColorTokens.background80)
    static let bg90 = dynamic(ColorTokens.background90)
    static let border = dynamic(ColorTokens.border)
    static let primary = dynamic(ColorTokens.primary)
    /// `--primary-foreground`: labels and glyphs on a `primary` fill (white
    /// in light, near-black in dark). Never put `Color.white` on `primary`.
    static let primaryForeground = dynamic(ColorTokens.primaryForeground)
    /// A disabled control's fill and label: the control changes colour
    /// instead of fading, so its label stays readable.
    static let disabledFill = dynamic(ColorTokens.disabledFill)
    static let disabledForeground = dynamic(ColorTokens.disabledForeground)
    static let destructive = dynamic(ColorTokens.destructive)
    /// The unread "completed" dot (session-leading-marker.tsx).
    static let dot = Color(hex: 0x307BD0)
    static let amber = Color(hex: 0xF59E0B)
    static let amber700 = Color(hex: 0xB45309)
    static let emerald500 = Color(hex: 0x10B981)
    static let emerald600 = Color(hex: 0x059669)
    static let rose500 = Color(hex: 0xF43F5E)
    static let red500 = Color(hex: 0xEF4444)
    static let blue600 = Color(hex: 0x2563EB)
    /// `rgba(23,24,27,.05)`: the pressed and selected row tint.
    static let pressed = dynamic(ColorTokens.text100, alpha: 0.05)
    /// The sheet grabber.
    static let grabber = dynamic(ColorTokens.strongBorder)
    /// The toast's card, under white text: near-black on light screens, the
    /// desktop's dark toast grey on dark ones (so it stands off the background).
    static let toast = dynamic(ColorTokens.toast)
    /// `rgba(0,0,0,.28)` behind a sheet.
    static let scrim = Color.black.opacity(0.28)
    /// text-shimmer.tsx `--base-color`: the shimmering label's resting grey.
    static let shimmerBase = dynamic(ThemedColor(light: 0xA1A1AA, dark: 0x71717A))
    /// The relation connector, `rgba(12,108,190,.6)`.
    static let connector = Color(hex: 0x0C6CBE).opacity(0.6)

    // Code and diffs.
    static func syntax(_ kind: SyntaxTokens.Kind) -> Color { dynamic(ColorTokens.syntax(kind)) }
    static let diffAddedLine = dynamic(ColorTokens.diffAdded, alpha: ColorTokens.diffLineOpacity)
    static let diffAddedNumber = dynamic(ColorTokens.diffAdded, alpha: ColorTokens.diffNumberOpacity)
    static let diffRemovedLine = dynamic(ColorTokens.diffRemoved, alpha: ColorTokens.diffLineOpacity)
    static let diffRemovedNumber = dynamic(ColorTokens.diffRemoved, alpha: ColorTokens.diffNumberOpacity)
    static let diffAdditionText = dynamic(ColorTokens.diffAdditionText)
    static let diffDeletionText = dynamic(ColorTokens.diffDeletionText)

    static func dynamic(_ token: ThemedColor, alpha: CGFloat = 1) -> Color {
        Color(UIColor { traits in
            UIColor(token[traits.userInterfaceStyle == .dark ? .dark : .light], alpha: alpha)
        })
    }
}

extension UIColor {
    convenience init(_ color: RGBColor, alpha: CGFloat = 1) {
        self.init(red: color.red, green: color.green, blue: color.blue, alpha: alpha)
    }

    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(UIColor(hex: hex, alpha: opacity))
    }

    /// `#rrggbb`, as project badge colours are stored.
    init?(hexString: String) {
        let digits = hexString.hasPrefix("#") ? String(hexString.dropFirst()) : hexString
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        self.init(hex: value)
    }
}
