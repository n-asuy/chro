import ChroDomain
import ChroServices
import SwiftUI

/// `.gprompt`: the composer card and, in a git project, the From / Worktree tray.
struct ComposerView: View {
    @Bindable var model: ComposerModel
    /// The From / Worktree tray; a session's composer has none.
    var showsTray: Bool?
    /// Nothing in the model pill can change (a turn is running).
    var isModelPickerDisabled = false
    /// Inside the card above the editor: the conversation's queue and image tiles.
    var header: AnyView?
    /// After the model pill: the conversation's Refs button.
    var accessory: AnyView?
    /// Replaces the Send button: the conversation's Send / Add to queue / Stop.
    var trailing: AnyView?
    let onSend: () -> Void
    @Environment(SheetPresenter.self) private var sheets
    @FocusState private var editorFocused: Bool

    private static let placeholder = "Research, write, or ship from your notes... @ for files, / for skills"

    var body: some View {
        VStack(spacing: 0) {
            // The composer keeps its full height (it grows with the text size);
            // what sits above it gives way instead.
            card.fixedSize(horizontal: false, vertical: true)
            if showsTray ?? !model.isScratch { tray }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(Palette.bg.opacity(0.8))
        .background(.ultraThinMaterial)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let header { header }
            if !model.references.isEmpty { referencePills }
            ZStack(alignment: .topLeading) {
                if model.text.isEmpty {
                    Text(Self.placeholder).textStyle(.composer).foregroundStyle(Palette.t300)
                        .fixedSize(horizontal: false, vertical: true)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                TextField("", text: $model.text, axis: .vertical)
                    .textStyle(.composer)
                    .foregroundStyle(Palette.fg)
                    .lineLimit(1...5)
                    .focused($editorFocused)
                    .accessibilityLabel("Message")
            }
                .frame(minHeight: 24, alignment: .top)
                .onChange(of: model.text) { old, new in openPickerOnTrigger(old: old, new: new) }
            HStack(spacing: 8) {
                HStack(spacing: 2) {
                    Button { sheets.present { ComposerContextSheet(model: model) } } label: {
                        Icon(.plus, size: 19).frame(width: 40, height: 40).minimumHitArea()
                    }
                    .buttonStyle(PressableStyle(cornerRadius: 20))
                    .foregroundStyle(Palette.t300)
                    .accessibilityLabel("Add context")
                    Rectangle().fill(Palette.border).frame(width: 1, height: 18).padding(.horizontal, 4)
                    modelPill
                    if let accessory { accessory }
                }
                Spacer(minLength: 0)
                if let trailing { trailing } else { sendButton }
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16).surface(Palette.bg, elevation: editorFocused ? .raised : .hairline))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.border))
        .zIndex(2)
    }

    private var referencePills: some View {
        FlowLayout(spacing: 6) {
            ForEach(model.references) { reference in
                Button { model.detach(reference) } label: {
                    HStack(spacing: 4) {
                        Text(reference.label).lineLimit(1)
                        Icon(.x, size: 12)
                    }
                    .textStyle(.referencePill)
                    .foregroundStyle(reference.kind == .skill ? Color(hex: 0x047857) : Palette.blue600)
                    .padding(.horizontal, 4)
                    .background(RoundedRectangle(cornerRadius: 4).fill(reference.kind == .skill ? Color(hex: 0xECFDF5) : Color(hex: 0xEFF6FF)))
                    .minimumHitArea()
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(reference.label)")
            }
        }
    }

    private var modelPill: some View {
        Button { sheets.present { ModelSheet(model: model) } } label: {
            HStack(spacing: 6) {
                AgentLogo(agent: model.runtime.agent, size: 16)
                Text(model.runtime.pillLabel).lineLimit(1)
                if let secondary = model.runtime.pillSecondary {
                    Text("·").foregroundStyle(Palette.t300.opacity(0.3))
                    Text(secondary).foregroundStyle(Palette.t300.opacity(0.7)).lineLimit(1)
                }
                Icon(.chevronDown, size: 13).opacity(0.6)
            }
            .textStyle(.modelPill)
            .foregroundStyle(Palette.t300)
            .padding(.horizontal, 8)
            .frame(height: 40)
            .background(RoundedRectangle(cornerRadius: 4).fill(isModelPickerDisabled ? Palette.muted.opacity(0.4) : .clear))
            .opacity(isModelPickerDisabled ? 0.4 : 1)
            .minimumHitArea()
        }
        .buttonStyle(PressableStyle(cornerRadius: 4))
        .disabled(isModelPickerDisabled)
        .accessibilityLabel("Model: \(model.runtime.pillLabel)")
    }

    private var sendButton: some View {
        Button(action: onSend) {
            Group {
                if model.isSending { Spinner(size: 17) } else { Icon(.arrowUpBold, size: 18) }
            }
            .frame(width: 36, height: 36)
            .primaryFill(isEnabled: model.canSend, in: Circle())
            .minimumHitArea()
        }
        .buttonStyle(.plain)
        .allowsHitTesting(model.canSend)
        .accessibilityLabel("Send")
        .accessibilityAddTraits(model.canSend ? [] : .isStaticText)
    }

    /// `.tray`: tucked under the card.
    private var tray: some View {
        HStack(spacing: 4) {
            TrayChip(icon: .gitBranch, label: model.baseBranch, accessibility: "From") {
                sheets.present { BranchSheet(model: model) }
            }
            // execution-options-controls.tsx: a dropdown of Worktree and Local.
            Menu {
                Picker("Checkout", selection: $model.useWorktree) {
                    Text("Worktree").tag(true)
                    Text("Local").tag(false)
                }
            } label: {
                TrayChipLabel(icon: .laptop, label: model.useWorktree ? "Worktree" : "Local")
            }
            .accessibilityLabel("Checkout: \(model.useWorktree ? "Worktree" : "Local")")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.top, 26)
        .frame(minHeight: 70, alignment: .top)
        .background(UnevenRoundedRectangle(bottomLeadingRadius: 16, bottomTrailingRadius: 16).fill(Palette.muted.opacity(0.6)))
        .padding(.horizontal, 2)
        .padding(.top, -26)
        .zIndex(1)
    }

    /// Typing `@` at a word start opens the context picker, `/` opens Skills.
    private func openPickerOnTrigger(old: String, new: String) {
        guard new.count == old.count + 1, new.hasPrefix(old), let typed = new.last, typed == "@" || typed == "/" else { return }
        let before = new.dropLast().last
        guard before == nil || before!.isWhitespace else { return }
        sheets.present(tall: true) { ContextPickerSheet(model: model, view: typed == "/" ? .skills : .root) }
    }
}

/// `.xchip`
struct TrayChip: View {
    let icon: LucideName
    let label: String
    let accessibility: String
    let action: () -> Void

    var body: some View {
        Button(action: action) { TrayChipLabel(icon: icon, label: label) }
            .buttonStyle(PressableStyle())
            .accessibilityLabel("\(accessibility): \(label)")
    }
}

/// A tray chip's glyph and value, shared by its button and menu forms.
struct TrayChipLabel: View {
    let icon: LucideName
    let label: String

    var body: some View {
        HStack(spacing: 8) {
            Icon(icon, size: 16).foregroundStyle(Palette.t300)
            Text(label).textStyle(.trayChip).foregroundStyle(Palette.fg).lineLimit(1)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

/// Wraps pills onto as many lines as they need.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += line + spacing; line = 0 }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
