import CoreText
import SwiftUI
import UIKit

/// InterVariable, as the desktop sets it: `font-feature-settings: "cv05", "calt"`
/// and a -0.006em default tracking. Weights are set on the `wght` axis so 500
/// and 600 render exactly as on the desktop.
enum Typography {
    /// Registers the bundled font once at launch.
    static func registerFonts() {
        guard let url = Bundle.main.url(forResource: "InterVariable", withExtension: "ttf") else {
            assertionFailure("InterVariable.ttf is missing from the bundle")
            return
        }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }

    static let family = "Inter"
    private static let weightAxis = 0x7767_6874 // 'wght'

    /// The unscaled face. Views use `TextStyle` (scaled by Dynamic Type);
    /// this is the base the scaling starts from.
    static func uiFont(size: CGFloat, weight: CGFloat = 400, tabular: Bool = false, design: TextStyle.Design = .inter) -> UIFont {
        if design == .monospaced {
            return .monospacedSystemFont(ofSize: size, weight: UIFont.Weight(cssWeight: weight))
        }
        var features: [[UIFontDescriptor.FeatureKey: Any]] = [
            [UIFontDescriptor.FeatureKey(rawValue: kCTFontOpenTypeFeatureTag as String): "cv05",
             UIFontDescriptor.FeatureKey(rawValue: kCTFontOpenTypeFeatureValue as String): 1],
        ]
        if tabular {
            features.append([UIFontDescriptor.FeatureKey(rawValue: kCTFontOpenTypeFeatureTag as String): "tnum",
                             UIFontDescriptor.FeatureKey(rawValue: kCTFontOpenTypeFeatureValue as String): 1])
        }
        let descriptor = UIFontDescriptor(fontAttributes: [
            .family: family,
            UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): [weightAxis: weight],
            .featureSettings: features,
        ])
        return UIFont(descriptor: descriptor, size: size)
    }
}

/// One text style of the mock: size in points at the default text size, CSS
/// weight, tracking in em. Every size scales with the reader's Dynamic Type
/// setting through `UIFontMetrics` of `relativeTo` (`.body` unless a style
/// says otherwise), so the mock's 16pt row title is 16pt at Large and grows
/// with the setting, up to `Typography.maximumDynamicTypeSize`.
struct TextStyle: Sendable {
    enum Design: Sendable { case inter, monospaced }

    var size: CGFloat
    var weight: CGFloat = 400
    var tracking: CGFloat = -0.006
    var tabular = false
    var uppercase = false
    var lineHeight: CGFloat? = nil
    var design: Design = .inter
    var relativeTo: UIFont.TextStyle = .body

    /// The size at a Dynamic Type setting.
    func scaledSize(_ dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        UIFontMetrics(forTextStyle: relativeTo)
            .scaledValue(for: size, compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize)))
    }

    /// The face at a Dynamic Type setting, for attributed strings and UIKit
    /// drawing a SwiftUI view measures (read `\.dynamicTypeSize` and pass it).
    func uiFont(_ dynamicTypeSize: DynamicTypeSize) -> UIFont {
        Typography.uiFont(size: scaledSize(dynamicTypeSize), weight: weight, tabular: tabular, design: design)
    }

    func font(_ dynamicTypeSize: DynamicTypeSize) -> Font { Font(uiFont(dynamicTypeSize)) }

    /// For UIKit text views: a face that follows the view's own content size
    /// category when the view sets `adjustsFontForContentSizeCategory`.
    var scalingUIFont: UIFont {
        UIFontMetrics(forTextStyle: relativeTo).scaledFont(for: Typography.uiFont(size: size, weight: weight, tabular: tabular, design: design))
    }

    /// The system monospaced face at a mock size (code, paths, ids).
    static func code(_ size: CGFloat, weight: CGFloat = 400) -> TextStyle {
        TextStyle(size: size, weight: weight, tracking: 0, design: .monospaced)
    }

    // Left panel
    static let rowTitle = TextStyle(size: 16)
    static let rowSubline = TextStyle(size: 13.5)
    static let rowTrailing = TextStyle(size: 15, tabular: true)
    static let sectionHeader = TextStyle(size: 12, weight: 500, tracking: 0.05, uppercase: true)
    static let projectName = TextStyle(size: 16)
    static let newChat = TextStyle(size: 16)
    static let versionChip = TextStyle(size: 12.5, weight: 500, tracking: 0.01, tabular: true)
    static let delegationCount = TextStyle(size: 13.5, tabular: true)
    static let emptyList = TextStyle(size: 15)
    // Navigation
    static let navTitle = TextStyle(size: 15, weight: 500, tracking: 0.01)
    static let done = TextStyle(size: 16, weight: 600)
    // Sheets
    static let sheetTitle = TextStyle(size: 15, weight: 600)
    static let menuItem = TextStyle(size: 15)
    static let menuLabel = TextStyle(size: 12.5)
    static let menuValue = TextStyle(size: 14)
    static let menuDetail = TextStyle(size: 12)
    static let search = TextStyle(size: 14)
    static let hint = TextStyle(size: 13)
    // Home
    static let overviewTitle = TextStyle(size: 18, weight: 500)
    static let overviewCaption = TextStyle(size: 12.5, tracking: 0.05, uppercase: true)
    static let quickAction = TextStyle(size: 15)
    static let quickActionTime = TextStyle(size: 12, tabular: true)
    static let chip = TextStyle(size: 13)
    static let trayChip = TextStyle(size: 14)
    static let composer = TextStyle(size: 15, lineHeight: 1.625)
    static let modelPill = TextStyle(size: 13.5, weight: 500)
    static let referencePill = TextStyle(size: 13.5)
    // Onboarding and pairing
    static let welcomeTitle = TextStyle(size: 30, weight: 600, tracking: -0.02, relativeTo: .title1)
    static let welcomeBody = TextStyle(size: 15, lineHeight: 1.625)
    static let stepTitle = TextStyle(size: 22, weight: 600, tracking: -0.02, relativeTo: .title2)
    static let stepBody = TextStyle(size: 14, lineHeight: 1.625)
    static let stepCaption = TextStyle(size: 12, weight: 500, tracking: 0.05, uppercase: true)
    static let stepProgress = TextStyle(size: 12, weight: 500)
    static let cardTitle = TextStyle(size: 15, weight: 500)
    static let cardDetail = TextStyle(size: 12.5)
    static let footnote = TextStyle(size: 12.5, lineHeight: 1.6)
    static let bigButton = TextStyle(size: 16, weight: 500)
    static let smallButton = TextStyle(size: 13)
    static let link = TextStyle(size: 13.5)
    static let mono = TextStyle(size: 12)
}

extension Typography {
    /// The largest Dynamic Type setting the app's text follows (applied at
    /// the root). Text keeps growing through the first two accessibility
    /// sizes (about twice the default); past that the phone layouts traced
    /// from the desktop (a row's title, subline and trailing time; a sheet's
    /// title and Done) would turn into one word per line. Bar buttons that
    /// cannot grow show the system's large content viewer instead.
    static let maximumDynamicTypeSize = DynamicTypeSize.accessibility2

    /// A ratio for spacing that should grow with the text (`@ScaledMetric`
    /// outside a view): 1 at the default size.
    static func scale(_ dynamicTypeSize: DynamicTypeSize, relativeTo style: UIFont.TextStyle = .body) -> CGFloat {
        UIFontMetrics(forTextStyle: style)
            .scaledValue(for: 100, compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))) / 100
    }
}

private extension UIFont.Weight {
    init(cssWeight: CGFloat) {
        switch cssWeight {
        case ..<450: self = .regular
        case ..<550: self = .medium
        case ..<650: self = .semibold
        default: self = .bold
        }
    }
}

extension View {
    /// Applies a mock text style at the reader's Dynamic Type size; line
    /// height is CSS's multiple of the size.
    func textStyle(_ style: TextStyle) -> some View {
        modifier(TextStyleModifier(style: style))
    }

    /// A line limit for the default sizes that lifts at accessibility sizes,
    /// where a truncated one-line title would show a word or two.
    func lineLimit(_ limit: Int, accessibility: Int?) -> some View {
        modifier(AdaptiveLineLimit(limit: limit, accessibility: accessibility))
    }
}

private struct TextStyleModifier: ViewModifier {
    let style: TextStyle
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        let font = style.uiFont(dynamicTypeSize)
        let size = font.pointSize
        let spacing = style.lineHeight.map { max(0, size * $0 - font.lineHeight) } ?? 0
        content
            .font(Font(font))
            .tracking(style.design == .inter ? size * style.tracking : 0)
            .textCase(style.uppercase ? .uppercase : nil)
            .lineSpacing(spacing)
    }
}

private struct AdaptiveLineLimit: ViewModifier {
    let limit: Int
    let accessibility: Int?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        content.lineLimit(dynamicTypeSize.isAccessibilitySize ? accessibility : limit)
    }
}
