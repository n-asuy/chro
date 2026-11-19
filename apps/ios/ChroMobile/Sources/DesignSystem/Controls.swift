import SwiftUI

/// The pressed tint every tappable row and icon uses (`rgba(23,24,27,.05)`).
struct PressableStyle: ButtonStyle {
    var cornerRadius: CGFloat = 6
    var pressedFill: Color = Palette.pressed
    var pressedForeground: Color? = nil

    func makeBody(configuration: Configuration) -> some View {
        PressableBody(configuration: configuration, cornerRadius: cornerRadius, pressedFill: pressedFill, pressedForeground: pressedForeground)
    }
}

/// Keeps the caller's foreground unless a pressed colour is given.
private struct PressableBody: View {
    let configuration: ButtonStyleConfiguration
    let cornerRadius: CGFloat
    let pressedFill: Color
    let pressedForeground: Color?

    var body: some View {
        let label = configuration.label
            .background(RoundedRectangle(cornerRadius: cornerRadius).fill(configuration.isPressed ? pressedFill : .clear))
            .contentShape(Rectangle())
        if configuration.isPressed, let pressedForeground {
            label.foregroundStyle(pressedForeground)
        } else {
            label
        }
    }
}

/// `.ib`: a 44×44 icon button in tertiary text, darker while pressed.
struct IconButton: View {
    let icon: LucideName
    var size: CGFloat = 20
    let label: String
    var tint: Color = Palette.t300
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Icon(icon, size: size)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(PressableStyle(pressedForeground: Palette.fg))
        .foregroundStyle(tint)
        .accessibilityLabel(label)
        // A bar glyph keeps its size at large text; holding it shows the label enlarged.
        .accessibilityShowsLargeContentViewer { Icon(icon, size: size); Text(label) }
    }
}

/// The blue "Done" of a sheet or a navigation bar.
struct DoneButton: View {
    var title = "Done"
    var weight: CGFloat = 600
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title).textStyle(TextStyle(size: 16, weight: weight))
                .padding(.horizontal, 10)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Palette.primary)
    }
}

/// `.back`: the blue chevron of a pushed screen.
struct BackButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Icon(.chevronLeft, size: 26)
                .padding(.leading, 2)
                .padding(.trailing, 6)
                .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Palette.primary)
        .accessibilityLabel("Back")
    }
}

/// `.navbar`: 48pt (taller at large text), back on the left, a centred title, actions on the right.
struct NavBar<Trailing: View>: View {
    var title: String
    var onBack: (() -> Void)?
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        ZStack {
            Text(title)
                .textStyle(.navTitle)
                .foregroundStyle(Palette.fg)
                .lineLimit(1)
                .padding(.horizontal, 96)
            HStack(spacing: 2) {
                if let onBack { BackButton(action: onBack) }
                Spacer(minLength: 0)
                trailing()
            }
            .padding(.horizontal, 4)
        }
        .frame(minHeight: 48)
    }
}

extension NavBar where Trailing == EmptyView {
    init(title: String, onBack: (() -> Void)?) {
        self.init(title: title, onBack: onBack, trailing: { EmptyView() })
    }
}

/// `.bigbtn`: the 50pt full-width call to action (taller when its label
/// wraps at large text). Disabled, it turns into a quiet surface with
/// tertiary text rather than fading, so the label stays readable.
struct BigButton: View {
    enum Kind { case primary, outline }
    let title: String
    var icon: LucideName? = nil
    var kind: Kind = .primary
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let icon { Icon(icon, size: 17) }
                Text(title).textStyle(.bigButton).multilineTextAlignment(.center)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 50)
            .foregroundStyle(foreground)
            .background(RoundedRectangle(cornerRadius: 8).fill(fill))
            .overlay {
                if kind == .outline { RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .allowsHitTesting(isEnabled)
        .accessibilityAddTraits(isEnabled ? [] : .isStaticText)
    }

    private var foreground: Color {
        guard isEnabled else { return Palette.disabledForeground }
        return kind == .primary ? Palette.primaryForeground : Palette.fg
    }

    private var fill: Color {
        switch kind {
        case .primary: return isEnabled ? Palette.primary : Palette.disabledFill
        case .outline: return Palette.bg
        }
    }
}

/// `.pill .pi`: the branch chip under the navigation bar.
struct BranchChip: View {
    let branch: String
    var target: String? = nil
    var action: (() -> Void)?

    var body: some View {
        let chip = HStack(spacing: 6) {
            Icon(.gitBranch, size: 15)
            Text(branch).lineLimit(1).truncationMode(.tail)
            if let target, target != branch {
                Text("→").foregroundStyle(Palette.t300)
                Text(target).foregroundStyle(Palette.t200)
            }
        }
        .textStyle(.chip)
        .foregroundStyle(Palette.fg)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .frame(minHeight: 32)
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        if let action {
            Button(action: action) { chip }.buttonStyle(.plain).accessibilityLabel("Open Source Control")
        } else {
            chip
        }
    }
}

/// `.badge`: the small grey count or label.
struct Badge: View {
    let text: String

    var body: some View {
        Text(text)
            .textStyle(TextStyle(size: 11, weight: 500))
            .foregroundStyle(Palette.t300)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4).fill(Palette.muted))
    }
}

/// `.radio`: the onboarding agent picker's 18pt radio.
struct RadioMark: View {
    let isOn: Bool

    var body: some View {
        Circle()
            .strokeBorder(isOn ? Palette.primary : Palette.t300.opacity(0.4), lineWidth: 1)
            .frame(width: 18, height: 18)
            .overlay { if isOn { Circle().fill(Palette.primary).frame(width: 9, height: 9) } }
    }
}

/// A checkbox's box: the primary fill with a `--primary-foreground` tick
/// when on, an outline when off.
struct CheckboxMark: View {
    let isOn: Bool
    var side: CGFloat = 22
    var tick: CGFloat = 13
    var cornerRadius: CGFloat = 4
    var offStroke: Color = Palette.border
    var lineWidth: CGFloat = 1

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .fill(isOn ? Palette.primary : .clear)
            .overlay(RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(isOn ? Palette.primary : offStroke, lineWidth: lineWidth))
            .overlay { if isOn { Icon(.checkBold, size: tick, scales: false).foregroundStyle(Palette.primaryForeground) } }
            .frame(width: side, height: side)
    }
}

extension View {
    /// Guarantees the 44pt platform hit area without changing the glyph's size.
    func minimumHitArea() -> some View {
        frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
    }
}

extension View {
    /// The `primary` treatment of a control drawn in `shape`: the primary
    /// fill with a `--primary-foreground` label; disabled, a quiet surface
    /// with tertiary text (colour, not opacity, so the label stays readable).
    func primaryFill(isEnabled: Bool = true, in shape: some Shape) -> some View {
        foregroundStyle(isEnabled ? Palette.primaryForeground : Palette.disabledForeground)
            .background(shape.fill(isEnabled ? Palette.primary : Palette.disabledFill))
    }
}

/// `.scope`: a small switch between views of one list (All changes /
/// Uncommitted, Changed / All files). The selected option is a raised pill on
/// a tonal track; each option's hit area reaches 44pt without growing the pill.
struct ScopeSwitch<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(value: Value, title: String)]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options.indices, id: \.self) { index in
                option(options[index].value, options[index].title)
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 5).fill(Palette.bg80))
    }

    private func option(_ value: Value, _ title: String) -> some View {
        let selected = selection == value
        return Button { selection = value } label: {
            Text(title)
                .textStyle(TextStyle(size: 13))
                .foregroundStyle(selected ? Palette.fg : Palette.t300)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background {
                    if selected { RoundedRectangle(cornerRadius: 4).surface(Palette.bg, elevation: .hairline) }
                }
                .padding(.vertical, 7)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -7)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

/// A list row: opens on tap, tinted while pressed. Its long press is the
/// system context menu (`.contextMenu`), as a desktop row's right click is.
/// Not a `Button`, so buttons inside the row (a disclosure, a count) stay
/// their own controls; callers combine the row for VoiceOver and give it
/// the button trait and the open action.
struct RowButton<Label: View>: View {
    let action: () -> Void
    @ViewBuilder var label: (_ pressed: Bool) -> Label
    @State private var pressed = false
    /// A press held into the context menu does not also open the row.
    @State private var heldIntoMenu = false

    var body: some View {
        label(pressed)
            .contentShape(Rectangle())
            .onTapGesture {
                if heldIntoMenu { heldIntoMenu = false } else { action() }
            }
            .onLongPressGesture(minimumDuration: 0.5, maximumDistance: 12) {
                heldIntoMenu = true
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(400))
                    heldIntoMenu = false
                }
            } onPressingChanged: { pressed = $0 }
    }
}

extension Label where Title == Text, Icon == Image {
    /// A system menu item with a lucide glyph, as the desktop's menus draw them.
    init(_ title: String, lucide: LucideName) {
        self.init(title, image: "Lucide/\(lucide.rawValue)")
    }
}

extension View {
    /// The lifted preview of a row's context menu keeps the row's rounded shape.
    func rowContextMenuShape() -> some View {
        contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 6))
    }
}
