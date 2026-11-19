import ChroDomain
import SwiftUI
import UIKit

/// What the code layout shows besides the text (`.ed`): change bars, the line
/// a search result points at, and find-in-file matches.
struct CodeDecorations: Equatable {
    var changedLines: Set<Int> = []
    var focusLine: Int?
    var findQuery = ""
    var currentMatch = 0
}

/// The code layout of the files editor: line numbers and change bars in the
/// gutter, highlighted monospaced text that does not wrap and scrolls both
/// ways, editable in place with the keyboard accessory bar.
struct CodeEditor: UIViewRepresentable {
    let path: String
    let text: String
    /// Bumped when the text changed under the editor (disk read, undo outside).
    let revision: Int
    let metrics: EditorMetrics
    let decorations: CodeDecorations
    let isEditable: Bool
    let onEdit: (String) -> Void
    let onFind: () -> Void
    /// Reports how many matches the find query has.
    let onMatchCount: (Int) -> Void

    func makeUIView(context: Context) -> CodeEditorView {
        let view = CodeEditorView()
        view.onEdit = onEdit
        view.onMatchCount = onMatchCount
        view.textView.inputAccessoryView = Self.accessory(for: view, onFind: onFind)
        view.configure(path: path, metrics: metrics, isEditable: isEditable)
        view.setText(text)
        view.apply(decorations, scroll: true)
        context.coordinator.revision = revision
        return view
    }

    func updateUIView(_ view: CodeEditorView, context: Context) {
        view.onEdit = onEdit
        view.onMatchCount = onMatchCount
        view.configure(path: path, metrics: metrics, isEditable: isEditable)
        if context.coordinator.revision != revision || (!view.textView.isFirstResponder && view.textView.text != text) {
            context.coordinator.revision = revision
            view.setText(text)
        }
        view.apply(decorations, scroll: decorations != view.decorations)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var revision = 0
    }

    @MainActor static func accessory(for view: CodeEditorView, onFind: @escaping () -> Void) -> UIView {
        let bar = KeyboardBar(onUndo: { [weak view] in view?.textView.undoManager?.undo() },
                              onRedo: { [weak view] in view?.textView.undoManager?.redo() },
                              onFind: onFind,
                              onDone: { [weak view] in view?.textView.resignFirstResponder() })
        return AccessoryHost(bar)
    }
}

/// Hosts a SwiftUI bar as a keyboard accessory view.
final class AccessoryHost<Content: View>: UIView {
    private let host: UIHostingController<Content>

    init(_ content: Content) {
        host = UIHostingController(rootView: content)
        super.init(frame: CGRect(x: 0, y: 0, width: 0, height: 44))
        autoresizingMask = .flexibleWidth
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: leadingAnchor), host.view.trailingAnchor.constraint(equalTo: trailingAnchor),
            host.view.topAnchor.constraint(equalTo: topAnchor), host.view.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: 44) }
}

/// The scrolling surface: gutter on the left, the text view beside it.
final class CodeEditorView: UIScrollView, UITextViewDelegate {
    /// `.cl .n` 40pt right-aligned with 10pt padding; the bar at 40, the text at 52.
    static let numberRight: CGFloat = 30
    static let barX: CGFloat = 40
    static let textX: CGFloat = 52
    static let topInset: CGFloat = 10
    static let bottomInset: CGFloat = 40

    /// TextKit 1, which keeps every line at exactly the paragraph line height the gutter assumes.
    let textView = UITextView(usingTextLayoutManager: false)
    private let gutter = CodeGutterView()
    private let focusBand = UIView()
    private(set) var decorations = CodeDecorations()
    private var path = ""
    private var metrics = EditorMetrics.standard
    private var matches: [NSRange] = []
    var onEdit: (String) -> Void = { _ in }
    var onMatchCount: (Int) -> Void = { _ in }

    /// Highlighting is skipped above this size to keep typing responsive (the desktop's safe mode).
    private static let highlightLimit = 200_000

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        alwaysBounceVertical = true
        keyboardDismissMode = .interactive
        showsHorizontalScrollIndicator = true
        focusBand.backgroundColor = UIColor(red: 12 / 255, green: 108 / 255, blue: 190 / 255, alpha: 0.08)
        focusBand.isHidden = true
        addSubview(focusBand)
        addSubview(gutter)
        textView.isScrollEnabled = false
        textView.backgroundColor = .clear
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.textContainer.widthTracksTextView = false
        textView.textContainer.heightTracksTextView = false
        textView.textContainer.size = CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer.lineBreakMode = .byClipping
        textView.autocorrectionType = .no
        textView.autocapitalizationType = .none
        textView.smartQuotesType = .no
        textView.smartDashesType = .no
        textView.spellCheckingType = .no
        textView.keyboardType = .asciiCapable
        textView.delegate = self
        textView.accessibilityIdentifier = "code-editor"
        addSubview(textView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func configure(path: String, metrics: EditorMetrics, isEditable: Bool) {
        textView.isEditable = isEditable
        guard path != self.path || metrics != self.metrics else { return }
        self.path = path
        self.metrics = metrics
        textView.accessibilityLabel = FilePath.name(path)
        restyle()
    }

    func setText(_ text: String) {
        let selection = textView.selectedRange
        textView.text = text
        restyle()
        let length = (text as NSString).length
        textView.selectedRange = NSRange(location: min(selection.location, length), length: 0)
    }

    func apply(_ decorations: CodeDecorations, scroll: Bool) {
        let previous = self.decorations
        self.decorations = decorations
        gutter.changed = decorations.changedLines
        if previous.findQuery != decorations.findQuery || previous.currentMatch != decorations.currentMatch {
            restyle()
            if scroll, !matches.isEmpty { reveal(matches[decorations.currentMatch % matches.count]) }
        }
        layoutContent()
        if scroll, previous.focusLine != decorations.focusLine, let line = decorations.focusLine { reveal(line: line) }
    }

    // MARK: Text view

    func textViewDidChange(_ textView: UITextView) {
        restyle()
        layoutContent()
        onEdit(textView.text)
    }

    // MARK: Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        layoutContent()
    }

    /// The text view reveals the caret by asking for its whole line fragment, which is as
    /// wide as the longest line. A rect wider than the view is aligned to its left edge,
    /// which scrolls the gutter off screen. Reveal the fragment's start with the gutter
    /// beside it instead: no horizontal movement unless the caret is really out of view.
    override func scrollRectToVisible(_ rect: CGRect, animated: Bool) {
        let start = rect.width > bounds.width - Self.textX ? CGRect(x: rect.minX, y: rect.minY, width: 1, height: rect.height) : rect
        let withGutter = start.union(CGRect(x: max(0, start.minX - Self.textX), y: start.minY, width: 1, height: start.height))
        super.scrollRectToVisible(withGutter.width <= bounds.width ? withGutter : start, animated: animated)
    }

    private var lineCount: Int { max(1, textView.text.components(separatedBy: "\n").count) }

    private func layoutContent() {
        let lineHeight = metrics.codeLine
        let lines = textView.text.components(separatedBy: "\n")
        let longest = lines.map { ($0 as NSString).length }.max() ?? 0
        let advance = ("M" as NSString).size(withAttributes: [.font: EditorFont.mono(metrics.codeSize)]).width
        let textWidth = max(bounds.width - Self.textX - 16, CGFloat(longest) * advance + 4)
        let textHeight = CGFloat(lineCount) * lineHeight
        textView.frame = CGRect(x: Self.textX, y: Self.topInset, width: textWidth, height: textHeight)
        gutter.frame = CGRect(x: 0, y: Self.topInset, width: Self.textX, height: textHeight)
        gutter.configure(lines: lineCount, lineHeight: lineHeight, font: EditorFont.mono(metrics.codeSize))
        contentSize = CGSize(width: Self.textX + textWidth + 16, height: Self.topInset + textHeight + Self.bottomInset)
        if let line = decorations.focusLine, line <= lineCount {
            focusBand.isHidden = false
            focusBand.frame = CGRect(x: 0, y: Self.topInset + CGFloat(line - 1) * lineHeight, width: max(contentSize.width, bounds.width), height: lineHeight)
        } else {
            focusBand.isHidden = true
        }
    }

    private func reveal(line: Int) {
        let y = Self.topInset + CGFloat(line - 1) * metrics.codeLine - 120
        layoutIfNeeded()
        setContentOffset(CGPoint(x: 0, y: max(0, min(y, contentSize.height - bounds.height))), animated: false)
    }

    private func reveal(_ range: NSRange) {
        let prefix = (textView.text as NSString).substring(to: range.location)
        let line = prefix.components(separatedBy: "\n").count
        reveal(line: line)
    }

    // MARK: Styling

    private func restyle() {
        let storage = textView.textStorage
        let full = NSRange(location: 0, length: storage.length)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = metrics.codeLine
        paragraph.maximumLineHeight = metrics.codeLine
        let font = EditorFont.mono(metrics.codeSize)
        let baselineOffset = (metrics.codeLine - font.lineHeight) / 4
        storage.beginEditing()
        storage.setAttributes([.font: font, .foregroundColor: UIColor(Palette.fg), .paragraphStyle: paragraph, .baselineOffset: baselineOffset], range: full)
        if storage.length <= Self.highlightLimit {
            var location = 0
            for line in textView.text.components(separatedBy: "\n") {
                var offset = location
                for token in SyntaxTokens.tokenize(line, path: path) {
                    let length = (token.text as NSString).length
                    if token.kind != .plain {
                        storage.addAttribute(.foregroundColor, value: UIColor(Palette.syntax(token.kind)), range: NSRange(location: offset, length: length))
                    }
                    offset += length
                }
                location += (line as NSString).length + 1
            }
        }
        matches = Self.matches(of: decorations.findQuery, in: textView.text)
        for (index, range) in matches.enumerated() {
            let current = index == decorations.currentMatch % max(matches.count, 1)
            storage.addAttribute(.backgroundColor, value: current ? UIColor(red: 249 / 255, green: 115 / 255, blue: 22 / 255, alpha: 0.55)
                                                                  : UIColor(red: 250 / 255, green: 204 / 255, blue: 21 / 255, alpha: 0.45), range: range)
        }
        storage.endEditing()
        textView.typingAttributes = [.font: font, .foregroundColor: UIColor(Palette.fg), .paragraphStyle: paragraph, .baselineOffset: baselineOffset]
        let count = matches.count
        DispatchQueue.main.async { [weak self] in self?.onMatchCount(count) }
    }

    /// Case-insensitive occurrences of `query` (the mock's find highlighting).
    static func matches(of query: String, in text: String) -> [NSRange] {
        guard !query.isEmpty else { return [] }
        let source = text as NSString
        var ranges: [NSRange] = []
        var searchRange = NSRange(location: 0, length: source.length)
        while true {
            let found = source.range(of: query, options: [.caseInsensitive], range: searchRange)
            guard found.location != NSNotFound, found.length > 0 else { break }
            ranges.append(found)
            let next = found.location + found.length
            searchRange = NSRange(location: next, length: source.length - next)
        }
        return ranges
    }
}

/// `.gut`: right-aligned line numbers and the green change bar.
final class CodeGutterView: UIView {
    var changed: Set<Int> = [] { didSet { if changed != oldValue { setNeedsDisplay() } } }
    private var lines = 0
    private var lineHeight: CGFloat = 20
    private var font = EditorFont.mono(13)

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func configure(lines: Int, lineHeight: CGFloat, font: UIFont) {
        guard lines != self.lines || lineHeight != self.lineHeight || font != self.font else { return }
        self.lines = lines
        self.lineHeight = lineHeight
        self.font = font
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor(Palette.t400)]
        let first = max(1, Int(rect.minY / lineHeight) + 1)
        let last = min(lines, Int(rect.maxY / lineHeight) + 1)
        guard first <= last else { return }
        for line in first...last {
            let top = CGFloat(line - 1) * lineHeight
            let label = String(line) as NSString
            let size = label.size(withAttributes: attributes)
            label.draw(at: CGPoint(x: CodeEditorView.numberRight - size.width, y: top + (lineHeight - size.height) / 2), withAttributes: attributes)
            if changed.contains(line) {
                UIColor(red: 34 / 255, green: 197 / 255, blue: 94 / 255, alpha: 0.7).setFill()
                UIRectFill(CGRect(x: CodeEditorView.barX, y: top, width: 3, height: lineHeight))
            }
        }
    }
}
