import ChroServices
import SwiftUI

/// feedback/feedback-popover.tsx as a sheet: pick a category, then write
/// and send. Feedback goes to the cloud API, as on the desktop.
struct FeedbackSheet: View {
    /// The maintainer's profile the menu links to.
    static let followURL = URL(string: "https://x.com/n_asuy")!
    static let followHandle = "@n_asuy"

    @Environment(\.panelServices) private var services
    @Environment(SheetPresenter.self) private var presenter
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.openURL) private var openURL
    @State private var category: FeedbackCategory?
    @State private var message = ""
    @State private var sending = false

    var body: some View {
        if let category {
            compose(category)
        } else {
            menu
        }
    }

    private var menu: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Feedback")
            SheetMenu {
                ForEach(FeedbackCategory.allCases, id: \.self) { category in
                    Button { self.category = category } label: {
                        HStack(spacing: 12) {
                            Icon(category.icon, size: 18).foregroundStyle(Palette.t300)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(category.title).textStyle(TextStyle(size: 14, weight: 500)).foregroundStyle(Palette.fg)
                                Text(category.detail).textStyle(TextStyle(size: 12.5)).foregroundStyle(Palette.t300)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .frame(minHeight: 52)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableStyle(pressedFill: Palette.muted))
                    .accessibilityLabel(category.title)
                    .accessibilityHint(category.detail)
                }
                MenuSeparator()
                Button { openURL(Self.followURL) } label: {
                    HStack(spacing: 12) {
                        ProfileMark().fill(Palette.t300, style: FillStyle(eoFill: true)).frame(width: 16, height: 16)
                        Text("Follow on X").textStyle(TextStyle(size: 14)).foregroundStyle(Palette.fg)
                        Spacer(minLength: 8)
                        Text(Self.followHandle).textStyle(TextStyle(size: 12.5)).foregroundStyle(Palette.t300)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle(pressedFill: Palette.muted))
                .accessibilityLabel("Follow on X")
                .accessibilityValue(Self.followHandle)
            }
        }
    }

    private func compose(_ category: FeedbackCategory) -> some View {
        VStack(spacing: 0) {
            SheetHeader(title: category.title, onBack: { self.category = nil })
            VStack(alignment: .trailing, spacing: 10) {
                FeedbackField(text: $message)
                SmallPrimaryButton(title: sending ? "Sending…" : "Send",
                                   isEnabled: !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending) {
                    send(category)
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func send(_ category: FeedbackCategory) {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        Task {
            do {
                try await services.system.submitFeedback(category: category, message: text)
                presenter.dismiss()
                toasts.show("Thanks for your feedback!")
            } catch {
                sending = false
                toasts.show("Couldn't send feedback. Please try again.")
            }
        }
    }
}

/// The six-row compose field, focused when it appears.
private struct FeedbackField: View {
    @Binding var text: String
    @FocusState private var focused: Bool

    var body: some View {
        TextField("", text: $text, prompt: Text("Share your thoughts with us…").foregroundStyle(Palette.t400), axis: .vertical)
            .textStyle(TextStyle(size: 15))
            .foregroundStyle(Palette.fg)
            .lineLimit(6...10)
            .focused($focused)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border))
            .accessibilityLabel("Share your thoughts with us…")
            .onAppear { focused = true }
    }
}

extension FeedbackCategory {
    var title: String {
        switch self {
        case .feedback: return "Give Feedback"
        case .bug: return "Report a bug"
        case .feature: return "Feature request"
        }
    }

    var detail: String {
        switch self {
        case .feedback: return "Share your thoughts & insights"
        case .bug: return "Help us improve with your catches"
        case .feature: return "Share your heart with us"
        }
    }

    var icon: LucideName {
        switch self {
        case .feedback: return .megaphone
        case .bug: return .bug
        case .feature: return .lightbulb
        }
    }
}

/// The profile service's logo the desktop shows beside "Follow on X" (24×24 path).
private struct ProfileMark: Shape {
    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 24
        var path = Path()
        let outer: [(CGFloat, CGFloat)] = [
            (18.244, 2.25), (21.552, 2.25), (14.325, 10.51), (22.827, 21.75), (16.17, 21.75), (10.956, 14.933),
            (4.99, 21.75), (1.68, 21.75), (9.41, 12.915), (1.254, 2.25), (8.08, 2.25), (12.793, 8.481),
        ]
        let inner: [(CGFloat, CGFloat)] = [(17.083, 19.77), (18.916, 19.77), (7.084, 4.126), (5.117, 4.126)]
        for points in [outer, inner] {
            path.addLines(points.map { CGPoint(x: rect.minX + $0.0 * scale, y: rect.minY + $0.1 * scale) })
            path.closeSubpath()
        }
        return path
    }
}
