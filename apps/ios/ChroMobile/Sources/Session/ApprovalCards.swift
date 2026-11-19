import ChroDomain
import ChroServices
import SwiftUI

extension EnvironmentValues {
    /// The tallest an approval card grows before its options scroll inside it:
    /// half the session screen, so the conversation stays in view on a small phone.
    @Entry var approvalCardMaxHeight: CGFloat = 400
}

/// `.qcard`: the AskUserQuestions card both approvals share (ask-user-questions.tsx).
private struct QuestionCardFrame<Header: View, Content: View, Footer: View>: View {
    let isDisabled: Bool
    @Environment(\.approvalCardMaxHeight) private var maxHeight
    @ViewBuilder var header: () -> Header
    @ViewBuilder var content: () -> Content
    @ViewBuilder var footer: () -> Footer

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) { header() }
                    .textStyle(TextStyle(size: 13))
                    .foregroundStyle(Palette.t300)
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 6)
                VStack(alignment: .leading, spacing: 8) { content() }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                footer()
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: maxHeight)
        .fixedSize(horizontal: false, vertical: true)
        .background(RoundedRectangle(cornerRadius: 12).fill(Palette.bg))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.border))
        .opacity(isDisabled ? 0.7 : 1)
        .allowsHitTesting(!isDisabled)
    }
}

private struct QuestionTitle: View {
    let text: String

    var body: some View {
        Text(text).textStyle(TextStyle(size: 16, weight: 600, lineHeight: 1.375)).foregroundStyle(Palette.fg)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }
}

/// `.opt`: an option row with its number chip.
private struct OptionRow: View {
    let title: String
    let detail: String?
    let number: Int
    var isSelected = false
    var isMuted = false
    var multiSelect = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                (Text(title).fontWeight(isSelected ? .semibold : .medium).foregroundColor(isMuted ? Palette.t300 : Palette.fg)
                    + Text(detail.map { " \($0)" } ?? "").foregroundColor(Palette.t300))
                    .textStyle(TextStyle(size: 15, lineHeight: 1.375))
                    .frame(maxWidth: .infinity, alignment: .leading)
                NumberChip(number: number, isSelected: isSelected, boxed: multiSelect)
            }
            .padding(.leading, 12)
            .padding(.trailing, 6)
            .padding(.vertical, 8)
            .frame(minHeight: 48)
            .background(RoundedRectangle(cornerRadius: 6).fill(isSelected ? Palette.bg80 : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(pressedFill: Palette.muted))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// `.chip7`: the option's number; multi-select draws it in a box, filled when selected.
private struct NumberChip: View {
    let number: Int
    let isSelected: Bool
    let boxed: Bool

    var body: some View {
        Text("\(number)")
            .textStyle(TextStyle(size: 12, weight: isSelected ? 600 : 500))
            .foregroundStyle(boxed && isSelected ? Palette.bg : isSelected ? Palette.fg : Palette.t300)
            .frame(width: 20, height: 20)
            .background {
                if boxed {
                    RoundedRectangle(cornerRadius: 6).fill(isSelected ? Palette.fg : .clear)
                    RoundedRectangle(cornerRadius: 6).strokeBorder(isSelected ? .clear : Palette.border)
                }
            }
            .frame(width: 28, height: 28)
            .accessibilityHidden(true)
    }
}

/// The agent's AskUserQuestion, one question at a time.
struct QuestionCard: View {
    @Bindable var model: SessionModel
    @FocusState private var otherFocused: Bool

    var body: some View {
        if let flow = model.questionFlow {
            let question = flow.current
            QuestionCardFrame(isDisabled: model.isResponding) {
                ForEach(Array(flow.headerParts.enumerated()), id: \.offset) { index, part in
                    if index > 0 { Text("•").foregroundStyle(Palette.t300.opacity(0.5)) }
                    Text(part)
                }
            } content: {
                QuestionTitle(text: question.question)
                VStack(spacing: 2) {
                    ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                        OptionRow(title: option.label, detail: option.description.isEmpty ? nil : option.description, number: index + 1,
                                  isSelected: flow.isSelected(index), multiSelect: question.multiSelect) {
                            model.updateFlow { $0.pick(index) }
                        }
                    }
                    otherRow(flow, number: question.options.count + 1)
                }
                .padding(.horizontal, -10)
            } footer: {
                if flow.showsFooter { footer(flow) }
            }
            .id(flow.index)
        }
    }

    private func otherRow(_ flow: QuestionFlow, number: Int) -> some View {
        let text = Binding(get: { model.questionFlow?.otherFieldText ?? "" }, set: { value in model.updateFlow { $0.otherText = value; return nil } })
        return HStack(alignment: .center, spacing: 12) {
            TextField("", text: text, prompt: Text("Describe in your own words…").foregroundStyle(Palette.t300), axis: .vertical)
                .textStyle(TextStyle(size: 15, weight: 500, lineHeight: 1.375))
                .foregroundStyle(Palette.fg)
                .focused($otherFocused)
                .submitLabel(.send)
                .onSubmit { if !flow.current.multiSelect { model.updateFlow { $0.submitOther() } } }
                .accessibilityLabel("Describe in your own words")
            if flow.showsSubmitArrow {
                Button { model.updateFlow { $0.submitOther() } } label: {
                    Icon(.arrowRight, size: 14).foregroundStyle(Palette.bg)
                        .frame(width: 20, height: 20)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Palette.fg))
                        .frame(width: 28, height: 28)
                        .minimumHitArea()
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Submit")
            } else {
                NumberChip(number: number, isSelected: flow.isOtherSelected, boxed: flow.current.multiSelect)
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .padding(.vertical, 8)
        .frame(minHeight: 48)
        .background(RoundedRectangle(cornerRadius: 6).fill(flow.isOtherSelected ? Palette.bg80 : .clear))
    }

    private func footer(_ flow: QuestionFlow) -> some View {
        HStack {
            if flow.showsBack {
                QuestionFooterButton(title: "Back", icon: .arrowLeft, leading: true) { model.updateFlow { $0.back(); return nil } }
            }
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                if flow.showsSkip { QuestionFooterButton(title: "Skip", icon: .arrowRight, leading: false) { model.updateFlow { $0.skip() } } }
                if flow.showsContinue {
                    Button { model.updateFlow { $0.continueMulti() } } label: {
                        Text(flow.continueTitle).textStyle(TextStyle(size: 13.5, weight: 500))
                            .padding(.horizontal, 14).padding(.vertical, 6).frame(minHeight: 36)
                            .primaryFill(isEnabled: flow.canContinue, in: RoundedRectangle(cornerRadius: 6))
                            .minimumHitArea()
                    }
                    .buttonStyle(.plain)
                    .disabled(!flow.canContinue)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
    }
}

/// `.ghostbtn`: Back and Skip.
private struct QuestionFooterButton: View {
    let title: String
    let icon: LucideName
    let leading: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if leading { Icon(icon, size: 15) }
                Text(title)
                if !leading { Icon(icon, size: 15) }
            }
            .textStyle(TextStyle(size: 13.5))
            .foregroundStyle(Palette.t300)
            .padding(.horizontal, 10)
            .frame(height: 36)
            .minimumHitArea()
        }
        .buttonStyle(PressableStyle())
    }
}

/// MCP tool approval (mcp-tool-approval.tsx): the shared card as one
/// non-skippable choice, with the call's parameters as detail.
struct McpApprovalCard: View {
    @Bindable var model: SessionModel
    let prompt: McpApprovalPrompt

    var body: some View {
        QuestionCardFrame(isDisabled: model.isResponding) {
            Text(prompt.headerLabel).lineLimit(1)
            if prompt.isOutsideSandbox {
                Spacer(minLength: 8)
                Text("Outside the sandbox")
                    .textStyle(TextStyle(size: 11, weight: 600, tracking: 0.05, uppercase: true))
                    .foregroundStyle(Palette.destructive)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.destructive.opacity(0.35)))
            }
        } content: {
            QuestionTitle(text: prompt.message)
            if !prompt.params.isEmpty { parameters }
            VStack(spacing: 2) {
                ForEach(Array(prompt.options.enumerated()), id: \.offset) { index, decision in
                    OptionRow(title: decision.title, detail: decision.detail, number: index + 1, isMuted: decision.isMuted) { model.decide(decision) }
                }
            }
            .padding(.horizontal, -10)
        } footer: {
            Color.clear.frame(height: 6)
        }
    }

    private var parameters: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(prompt.params.enumerated()), id: \.offset) { index, param in
                if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
                if param.isMultiline {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(param.label).foregroundStyle(Palette.t300)
                        ScrollView { Text(param.value).textStyle(.code(11)).foregroundStyle(Palette.fg) }.frame(maxHeight: 160)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 7)
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(param.label).foregroundStyle(Palette.t300).frame(width: 84, alignment: .leading)
                        Text(param.value).foregroundStyle(Palette.fg).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 7)
                }
            }
        }
        .textStyle(TextStyle(size: 13))
        .background(RoundedRectangle(cornerRadius: 8).fill(Palette.muted.opacity(0.3)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border))
        .padding(.bottom, 4)
    }
}
