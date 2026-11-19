import Foundation

/// The user's accent seed and what the desktop derives from it per theme
/// (settings/lib/accent-derivation.ts): the solid accent with its lightness
/// clamped into the mode's band, chroma floored and capped to the sRGB gamut
/// in OKLCH, and the text colour on it chosen by WCAG contrast.
public struct AccentColor: Equatable, Sendable {
    public typealias Mode = ThemeMode

    public static let defaultHex = "#0c6cbe"

    public let seed: RGBColor

    public init?(hex: String) {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        seed = RGBColor(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
    }

    /// `--primary`.
    public func primary(_ mode: Mode) -> RGBColor { Self.rgb(base(mode)) }

    /// `--primary-foreground`.
    public func foreground(_ mode: Mode) -> RGBColor {
        let fill = primary(mode)
        let light = RGBColor(red: 1, green: 1, blue: 1)
        let dark = RGBColor(red: 0x0B / 255, green: 0x0F / 255, blue: 0x14 / 255)
        return light.contrast(with: fill) >= dark.contrast(with: fill) ? light : dark
    }

    // MARK: - Derivation

    private static let chromaFloor = 0.045
    private static let neutralHue = 250.0

    private struct Oklch { var l: Double, c: Double, h: Double? }

    private func base(_ mode: Mode) -> Oklch {
        let (lMin, lMax) = mode == .light ? (0.4, 0.62) : (0.62, 0.82)
        let parsed = Self.oklch(seed)
        let candidate = Oklch(l: min(lMax, max(lMin, parsed.l)), c: max(parsed.c, Self.chromaFloor), h: parsed.h ?? Self.neutralHue)
        return Self.clampChroma(candidate)
    }

    /// culori `clampChroma(color, "oklch")`: the largest chroma at this
    /// lightness and hue that stays inside sRGB.
    private static func clampChroma(_ color: Oklch) -> Oklch {
        if inGamut(color) { return color }
        var low = 0.0, high = color.c
        var result = Oklch(l: color.l, c: 0, h: color.h)
        while high - low > 0.0001 {
            let mid = (low + high) / 2
            let probe = Oklch(l: color.l, c: mid, h: color.h)
            if inGamut(probe) {
                low = mid
                result = probe
            } else {
                high = mid
            }
        }
        return result
    }

    private static func inGamut(_ color: Oklch) -> Bool {
        let linear = linearRGB(color)
        let epsilon = 1e-6
        return [linear.0, linear.1, linear.2].allSatisfy { $0 >= -epsilon && $0 <= 1 + epsilon }
    }

    private static func oklch(_ color: RGBColor) -> Oklch {
        let r = toLinear(color.red), g = toLinear(color.green), b = toLinear(color.blue)
        let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        let lightness = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
        let a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
        let bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
        let chroma = (a * a + bAxis * bAxis).squareRoot()
        // culori leaves the hue undefined for achromatic colours.
        let hue = chroma < 4e-4 ? nil : { () -> Double in
            let degrees = atan2(bAxis, a) * 180 / .pi
            return degrees < 0 ? degrees + 360 : degrees
        }()
        return Oklch(l: lightness, c: chroma, h: hue)
    }

    private static func linearRGB(_ color: Oklch) -> (Double, Double, Double) {
        let radians = (color.h ?? 0) * .pi / 180
        let a = color.c * cos(radians), b = color.c * sin(radians)
        let l = pow(color.l + 0.3963377774 * a + 0.2158037573 * b, 3)
        let m = pow(color.l - 0.1055613458 * a - 0.0638541728 * b, 3)
        let s = pow(color.l - 0.0894841775 * a - 1.2914855480 * b, 3)
        return (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    }

    private static func rgb(_ color: Oklch) -> RGBColor {
        let linear = linearRGB(color)
        return RGBColor(red: fromLinear(linear.0), green: fromLinear(linear.1), blue: fromLinear(linear.2))
    }

    private static func toLinear(_ value: Double) -> Double {
        let magnitude = abs(value)
        let linear = magnitude <= 0.04045 ? magnitude / 12.92 : pow((magnitude + 0.055) / 1.055, 2.4)
        return value < 0 ? -linear : linear
    }

    private static func fromLinear(_ value: Double) -> Double {
        let magnitude = abs(value)
        let encoded = magnitude > 0.0031308 ? 1.055 * pow(magnitude, 1 / 2.4) - 0.055 : 12.92 * magnitude
        return value < 0 ? -encoded : encoded
    }
}
