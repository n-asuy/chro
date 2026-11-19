import SwiftUI

/// The desktop's toast (title and optional description), dark card above the composer.
@MainActor @Observable
final class ToastCenter {
    struct Toast: Identifiable, Equatable {
        let id = UUID()
        var title: String
        var description: String?
    }

    private(set) var current: Toast?
    private var dismissal: Task<Void, Never>?

    func show(_ title: String, description: String? = nil) {
        current = Toast(title: title, description: description)
        dismissal?.cancel()
        dismissal = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            self?.current = nil
        }
    }
}

struct ToastHost<Content: View>: View {
    let center: ToastCenter
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .overlay(alignment: .bottom) {
                if let toast = center.current {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(toast.title).textStyle(TextStyle(size: 13.5, weight: 600))
                        if let description = toast.description { Text(description).textStyle(TextStyle(size: 13.5)) }
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).surface(Palette.toast, elevation: .raised))
                    .padding(.horizontal, 16)
                    .padding(.bottom, 120)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                    .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .animation(.easeOut(duration: 0.2), value: center.current)
            .environment(center)
    }
}
