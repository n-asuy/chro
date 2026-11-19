import SwiftUI
import UIKit

/// The dock sheet keeps its height while the keyboard is up, so a panel's
/// scroll view adds the keyboard's height as bottom content margin: rows the
/// keyboard covers can still be scrolled into view.
private struct KeyboardOverlapMargin: ViewModifier {
    @State private var overlap: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .contentMargins(.bottom, overlap, for: .scrollContent)
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
                guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
                      let screen = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen else { return }
                overlap = max(0, screen.bounds.maxY - frame.minY)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in overlap = 0 }
    }
}

extension View {
    func keyboardOverlapMargin() -> some View { modifier(KeyboardOverlapMargin()) }
}
