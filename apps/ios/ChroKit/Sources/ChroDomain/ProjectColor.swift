import Foundation

/// project-color-picker.tsx: the hue/value field and the saturation slider.
public enum ProjectColorPicker {
    /// - Parameters:
    ///   - x: 0…1 across the field (hue 0…360).
    ///   - y: 0…1 down the field (value 0.92…0.30).
    ///   - saturation: the slider, 10…100 (saturation 0.3 + s/100 × 0.45).
    /// - Returns: `#rrggbb`.
    public static func hex(x: Double, y: Double, saturation: Double) -> String {
        let x = min(1, max(0, x)), y = min(1, max(0, y))
        let hue = x * 360, value = 0.92 - y * 0.62, sat = 0.3 + saturation / 100 * 0.45
        func channel(_ n: Double) -> Int {
            let k = (n + hue / 60).truncatingRemainder(dividingBy: 6)
            return Int((value - value * sat * max(0, min(k, 4 - k, 1))) * 255 + 0.5)
        }
        return "#" + [channel(5), channel(3), channel(1)].map { String(format: "%02x", $0) }.joined()
    }

    public static let defaultSaturation: Double = 55
}
