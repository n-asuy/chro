import SwiftUI

/// The mock's settings building blocks (settings-section.tsx, settings-row.tsx).
enum SettingsStyle {
    static let cardBorder = Palette.border.opacity(0.7)
    static let rowSeparator = Palette.border.opacity(0.5)
    static let selectBorder = Palette.border.opacity(0.6)
}

/// `.pane`: the scrolling column of a pane screen.
struct SettingsPaneColumn<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) { content() }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
    }
}

/// `.pane > header`.
struct SettingsPaneHeader: View {
    let title: String
    var description: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).textStyle(TextStyle(size: 20, weight: 700)).foregroundStyle(Palette.fg)
                .accessibilityAddTraits(.isHeader)
            if let description {
                Text(description).textStyle(TextStyle(size: 13, lineHeight: 1.5)).foregroundStyle(Palette.t300)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// `.sec`: an optional heading with an action, an optional description, and the card.
struct SettingsSection<Action: View, Content: View>: View {
    var heading: String?
    var description: String?
    /// False leaves the heading alone: a card with nothing in it reads as broken.
    var hasContent = true
    @ViewBuilder var action: () -> Action
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let heading {
                SettingsRowLayout(spacing: 8, stackedSpacing: 4) {
                    Text(heading).textStyle(TextStyle(size: 14, weight: 600)).foregroundStyle(Palette.fg)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityAddTraits(.isHeader)
                    action()
                }
                .padding(.horizontal, 2)
                .padding(.bottom, 8)
            }
            if let description {
                Text(description).textStyle(TextStyle(size: 12, lineHeight: 1.5)).foregroundStyle(Palette.t300)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 2)
                    .padding(.top, heading == nil ? 0 : -4)
                    .padding(.bottom, 8)
            }
            if hasContent {
                VStack(alignment: .leading, spacing: 0) { content() }
                    .background(RoundedRectangle(cornerRadius: 16).fill(Palette.bg))
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(SettingsStyle.cardBorder))
            }
        }
    }
}

extension SettingsSection where Action == EmptyView {
    init(heading: String? = nil, description: String? = nil, hasContent: Bool = true, @ViewBuilder content: @escaping () -> Content) {
        self.init(heading: heading, description: description, hasContent: hasContent, action: { EmptyView() }, content: content)
    }
}

/// `.srow2`: title, description and control on one line, extra content below.
struct SettingsRow<Control: View, Extra: View>: View {
    let title: String
    var description: String?
    var isFirst = false
    var isDisabled = false
    @ViewBuilder var control: () -> Control
    @ViewBuilder var extra: () -> Extra

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsRowLayout {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).textStyle(TextStyle(size: 14, weight: 500)).foregroundStyle(Palette.fg)
                    if let description {
                        Text(description).textStyle(TextStyle(size: 12.5, lineHeight: 1.5)).foregroundStyle(Palette.t300)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                control()
            }
            extra()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { if !isFirst { Rectangle().fill(SettingsStyle.rowSeparator).frame(height: 1) } }
        .opacity(isDisabled ? 0.6 : 1)
        .allowsHitTesting(!isDisabled)
    }
}

/// settings-row.tsx puts the label and the control on one line (a section
/// heading and its action likewise). On a phone a
/// wide control (three segments, a large text size) would squeeze the label
/// into a narrow column, so once the control needs more than half the row it
/// goes under the label at the row's full width.
struct SettingsRowLayout: Layout {
    var spacing: CGFloat = 12
    var stackedSpacing: CGFloat = 10

    private func stacks(width: CGFloat, control: CGSize) -> Bool { control.width > width / 2 }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        // A heading without an action: the label alone.
        if subviews.count == 1 { return subviews[0].sizeThatFits(ProposedViewSize(width: proposal.width, height: nil)) }
        guard subviews.count == 2 else { return .zero }
        let control = subviews[1].sizeThatFits(.unspecified)
        let width = proposal.width ?? (subviews[0].sizeThatFits(.unspecified).width + spacing + control.width)
        if stacks(width: width, control: control) {
            let label = subviews[0].sizeThatFits(ProposedViewSize(width: width, height: nil))
            let stacked = subviews[1].sizeThatFits(ProposedViewSize(width: width, height: nil))
            return CGSize(width: width, height: label.height + stackedSpacing + stacked.height)
        }
        let label = subviews[0].sizeThatFits(ProposedViewSize(width: width - control.width - spacing, height: nil))
        return CGSize(width: width, height: max(label.height, control.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        if subviews.count == 1 { subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: nil)); return }
        guard subviews.count == 2 else { return }
        let control = subviews[1].sizeThatFits(.unspecified)
        if stacks(width: bounds.width, control: control) {
            let full = ProposedViewSize(width: bounds.width, height: nil)
            let label = subviews[0].sizeThatFits(full)
            subviews[0].place(at: bounds.origin, proposal: full)
            subviews[1].place(at: CGPoint(x: bounds.minX, y: bounds.minY + label.height + stackedSpacing), proposal: full)
        } else {
            let labelWidth = bounds.width - control.width - spacing
            subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(width: labelWidth, height: nil))
            subviews[1].place(at: CGPoint(x: bounds.maxX, y: bounds.midY), anchor: .trailing, proposal: ProposedViewSize(control))
        }
    }
}

extension SettingsRow where Extra == EmptyView {
    init(title: String, description: String? = nil, isFirst: Bool = false, isDisabled: Bool = false,
         @ViewBuilder control: @escaping () -> Control) {
        self.init(title: title, description: description, isFirst: isFirst, isDisabled: isDisabled, control: control, extra: { EmptyView() })
    }
}

/// A padded line inside a card that is not a settings row (a status line, a hint).
struct SettingsCardLine<Content: View>: View {
    var isFirst = true
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(spacing: 8) { content() }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { if !isFirst { Rectangle().fill(SettingsStyle.rowSeparator).frame(height: 1) } }
    }
}

/// `.sw`: the 51×31 switch, primary when on, with a 44pt hit area.
struct SettingsSwitch: View {
    let title: String
    let isOn: Bool
    var isEnabled = true
    let action: (Bool) -> Void

    var body: some View {
        Button { action(!isOn) } label: {
            Capsule()
                .fill(isOn ? Palette.primary : Palette.border)
                .frame(width: 51, height: 31)
                .overlay(alignment: isOn ? .trailing : .leading) {
                    Circle().fill(Color.white)
                        .frame(width: 27, height: 27)
                        .shadow(color: .black.opacity(0.10), radius: 1, y: 1)
                        .shadow(color: .black.opacity(0.07), radius: 4, y: 3)
                        .padding(2)
                }
                .animation(.easeOut(duration: 0.15), value: isOn)
                .frame(minWidth: 51, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel(title)
        .accessibilityValue(isOn ? "1" : "0")
        .accessibilityAddTraits(.isToggle)
    }
}

/// `.selbtn`: the current value and a chevron; opens an option list.
struct SettingsSelectButton: View {
    let title: String
    let value: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(value).textStyle(TextStyle(size: 14)).foregroundStyle(Palette.fg).lineLimit(1)
                Icon(.chevronDown, size: 16).foregroundStyle(Palette.t300)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 40)
            .background(RoundedRectangle(cornerRadius: 8).fill(Palette.bg90))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(SettingsStyle.selectBorder))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel(title)
        .accessibilityValue(value)
    }
}

/// `.ghostbtn`: a quiet text button with an optional leading glyph.
struct GhostButton<Leading: View>: View {
    let title: String
    var bordered = false
    var fontSize: CGFloat = 13.5
    var isEnabled = true
    @ViewBuilder var leading: () -> Leading
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                leading()
                Text(title).textStyle(TextStyle(size: fontSize))
            }
            .foregroundStyle(Palette.t300)
            .padding(.horizontal, 10)
            .frame(height: 36)
            .overlay { if bordered { RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.border) } }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(pressedForeground: Palette.fg))
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.5)
    }
}

extension GhostButton where Leading == EmptyView {
    init(title: String, bordered: Bool = false, fontSize: CGFloat = 13.5, isEnabled: Bool = true, action: @escaping () -> Void) {
        self.init(title: title, bordered: bordered, fontSize: fontSize, isEnabled: isEnabled, leading: { EmptyView() }, action: action)
    }
}

/// A 14pt glyph or the spinner while busy, for ghost buttons.
struct GhostGlyph: View {
    let icon: LucideName
    var busy = false

    var body: some View {
        if busy { Spinner(size: 14) } else { Icon(icon, size: 14) }
    }
}

/// `.segf`: a segmented field of text options.
struct SegmentedField<Value: Hashable>: View {
    let options: [(Value, String)]
    let selection: Value
    let action: (Value) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { value, label in
                Button { action(value) } label: {
                    Text(label).textStyle(TextStyle(size: 13))
                        .foregroundStyle(value == selection ? Palette.fg : Palette.t300)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 40)
                        .background(RoundedRectangle(cornerRadius: 4).fill(value == selection ? Palette.muted : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(value == selection ? .isSelected : [])
            }
        }
        .padding(2)
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
        .fixedSize()
        .frame(minHeight: 44)
    }
}

/// `.cmdcode`: a shell command; copyable when `onCopy` is set.
struct CommandSnippet: View {
    let command: String
    var copied = false
    var onCopy: (() -> Void)?

    var body: some View {
        let label = HStack(spacing: 6) {
            Text(command).textStyle(.code(11.5)).foregroundStyle(Palette.fg)
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if onCopy != nil {
                Icon(copied ? .check : .copy, size: 12).foregroundStyle(copied ? Palette.emerald500 : Palette.t300)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(minHeight: onCopy == nil ? nil : 44)
        .background(RoundedRectangle(cornerRadius: 4).fill(Palette.border.opacity(0.4)))
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border.opacity(0.8)))
        .padding(.top, 4)
        if let onCopy {
            Button(action: onCopy) { label }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy command")
                .accessibilityValue(command)
                .accessibilityAddTraits(copied ? .isSelected : [])
        } else {
            label.textSelection(.enabled)
        }
    }
}

/// `.pbtn`: the small primary button.
struct SmallPrimaryButton<Leading: View>: View {
    let title: String
    var isEnabled = true
    @ViewBuilder var leading: () -> Leading
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                leading()
                Text(title).textStyle(TextStyle(size: 13.5, weight: 500))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .frame(minHeight: 36)
            .primaryFill(isEnabled: isEnabled, in: RoundedRectangle(cornerRadius: 6))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
    }
}

extension SmallPrimaryButton where Leading == EmptyView {
    init(title: String, isEnabled: Bool = true, action: @escaping () -> Void) {
        self.init(title: title, isEnabled: isEnabled, leading: { EmptyView() }, action: action)
    }
}

/// `.loadrow`: a spinner and a status line.
struct LoadingLine: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Spinner(size: 15)
            Text(text).textStyle(TextStyle(size: 14))
        }
        .foregroundStyle(Palette.t300)
    }
}

/// `.uplab`: the small uppercase field label.
struct UppercaseLabel: View {
    let text: String

    var body: some View {
        Text(text).textStyle(TextStyle(size: 11, weight: 500, tracking: 0.05, uppercase: true)).foregroundStyle(Palette.t300)
    }
}
