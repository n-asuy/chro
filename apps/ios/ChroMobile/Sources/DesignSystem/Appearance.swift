import SwiftUI

/// The theme choice. Per the mobile architecture, the theme is a per-device
/// setting (UserDefaults), not shared with the desktop.
enum ThemeChoice: String, CaseIterable, Identifiable {
    case dark, light, system

    static let storageKey = "chro.appearance.theme"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .dark: return "Dark"
        case .light: return "Light"
        case .system: return "System"
        }
    }

    /// nil follows the system.
    var colorScheme: ColorScheme? {
        switch self {
        case .dark: return .dark
        case .light: return .light
        case .system: return nil
        }
    }
}
