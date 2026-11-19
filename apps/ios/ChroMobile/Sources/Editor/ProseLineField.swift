import ChroDomain
import SwiftUI
import UIKit

/// The source of one prose line while it has focus (the mock's focused
/// `.bl`): a growing text view where Return splits the line and Backspace at
/// its start joins it to the previous one; the keyboard bar carries Undo,
/// Redo and the formatting menu.
struct ProseLineField: UIViewRepresentable {
    let text: String
    /// Caret position in characters, applied once when the field takes focus.
    let caret: Int
    let fontSize: CGFloat
    let lineHeight: CGFloat
    let onChange: (String) -> Void
    let onReturn: (_ text: String, _ caret: Int) -> Void
    let onBackspaceAtStart: (_ text: String) -> Void
    let onEnd: (_ text: String) -> Void

    func makeUIView(context: Context) -> LineTextView {
        let view = LineTextView()
        view.delegate = context.coordinator
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.autocapitalizationType = .sentences
        view.accessibilityIdentifier = "prose-line"
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        context.coordinator.field = self
        view.onBackspaceAtStart = { [weak view] in
            guard let view else { return }
            context.coordinator.field.onBackspaceAtStart(view.text)
        }
        view.inputAccessoryView = AccessoryHost(KeyboardBar(
            onUndo: { [weak view] in view?.undoManager?.undo() },
            onRedo: { [weak view] in view?.undoManager?.redo() },
            formats: [
                [.init(icon: .bold, label: "Bold") { [weak view] in view?.wrap("**") },
                 .init(icon: .italic, label: "Italic") { [weak view] in view?.wrap("*") },
                 .init(icon: .strikethrough, label: "Strikethrough") { [weak view] in view?.wrap("~~") }],
                [.init(icon: .code, label: "Inline Code") { [weak view] in view?.wrap("`") },
                 .init(icon: .highlighter, label: "Highlight") { [weak view] in view?.wrap("==") }],
                [.init(icon: .link, label: "Insert Link") { [weak view] in view?.insertLink() }],
            ],
            onDone: { [weak view] in view?.resignFirstResponder() }))
        view.text = text
        view.applyStyle(fontSize: fontSize, lineHeight: lineHeight)
        DispatchQueue.main.async {
            view.becomeFirstResponder()
            view.setCaret(characters: caret)
        }
        return view
    }

    func updateUIView(_ view: LineTextView, context: Context) {
        context.coordinator.field = self
        if view.text != text {
            view.text = text
            view.applyStyle(fontSize: fontSize, lineHeight: lineHeight)
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: LineTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? UIScreen.main.bounds.width
        let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: max(size.height, lineHeight * fontSize))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var field: ProseLineField

        init(_ field: ProseLineField) { self.field = field }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
            guard replacement == "\n" else { return true }
            let caret = (textView as? LineTextView)?.characterOffset(of: range.location) ?? textView.text.count
            field.onReturn(textView.text, caret)
            return false
        }

        func textViewDidChange(_ textView: UITextView) {
            (textView as? LineTextView)?.applyStyle(fontSize: field.fontSize, lineHeight: field.lineHeight)
            field.onChange(textView.text)
        }

        func textViewDidEndEditing(_ textView: UITextView) { field.onEnd(textView.text) }
    }
}

/// A text view that reports Backspace at offset 0 and applies markdown wraps.
final class LineTextView: UITextView {
    var onBackspaceAtStart: () -> Void = {}

    override func deleteBackward() {
        if selectedRange.location == 0, selectedRange.length == 0 {
            onBackspaceAtStart()
            return
        }
        super.deleteBackward()
    }

    func applyStyle(fontSize: CGFloat, lineHeight: CGFloat) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = fontSize * lineHeight
        paragraph.maximumLineHeight = fontSize * lineHeight
        let attributes: [NSAttributedString.Key: Any] = [
            .font: Typography.uiFont(size: fontSize), .foregroundColor: UIColor(Palette.fg), .paragraphStyle: paragraph,
        ]
        let selection = selectedRange
        textStorage.setAttributes(attributes, range: NSRange(location: 0, length: textStorage.length))
        typingAttributes = attributes
        selectedRange = selection
    }

    func characterOffset(of utf16: Int) -> Int {
        let string = text ?? ""
        let index = String.Index(utf16Offset: min(utf16, string.utf16.count), in: string)
        return string.distance(from: string.startIndex, to: index)
    }

    func setCaret(characters: Int) {
        let string = text ?? ""
        let index = string.index(string.startIndex, offsetBy: min(max(0, characters), string.count))
        selectedRange = NSRange(location: index.utf16Offset(in: string), length: 0)
    }

    private var characterSelection: Range<Int> {
        let lower = characterOffset(of: selectedRange.location)
        let upper = characterOffset(of: selectedRange.location + selectedRange.length)
        return lower..<upper
    }

    func wrap(_ marker: String) { replace(with: ProseEditing.wrap(text, selection: characterSelection, marker: marker)) }

    func insertLink() { replace(with: ProseEditing.link(text, selection: characterSelection)) }

    private func replace(with wrapped: ProseEditing.Wrapped) {
        // Through the undo-aware text input path, so Undo reverts the wrap.
        selectedRange = NSRange(location: 0, length: (text as NSString).length)
        insertText(wrapped.text)
        let string = text ?? ""
        let lower = string.index(string.startIndex, offsetBy: min(wrapped.selection.lowerBound, string.count))
        let upper = string.index(string.startIndex, offsetBy: min(wrapped.selection.upperBound, string.count))
        selectedRange = NSRange(location: lower.utf16Offset(in: string), length: upper.utf16Offset(in: string) - lower.utf16Offset(in: string))
    }
}
