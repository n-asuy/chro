import ChroDomain
import SwiftUI

/// A code diff's face and row metrics at the reader's text size: Menlo 12
/// on a 1.6 line, a 34pt line-number column (`.dl .n`) at the default size.
private struct CodeMetrics {
    let uiFont: UIFont
    let lineHeight: CGFloat
    let numberColumnWidth: CGFloat
    var font: Font { Font(uiFont) }

    init(_ dynamicTypeSize: DynamicTypeSize) {
        let size = TextStyle(size: 12).scaledSize(dynamicTypeSize)
        uiFont = UIFont(name: "Menlo", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
        lineHeight = (size * 1.6).rounded()
        numberColumnWidth = (34 * size / 12).rounded()
    }
}

/// The width a column of code rows needs so every row's tint reaches the
/// longest line and at least the visible width.
private func rowWidth(_ lines: [DiffHunks.Line], numberColumns: Int, visible: CGFloat, metrics: CodeMetrics) -> CGFloat {
    let text = lines.reduce(CGFloat(0)) { widest, line in
        max(widest, ("+" + line.text as NSString).size(withAttributes: [.font: metrics.uiFont]).width)
    }
    return max(visible, CGFloat(numberColumns) * metrics.numberColumnWidth + 4 + text + 10)
}

/// `.dtable`: a code file's hunks, unified or side by side, line numbers on
/// the left, scrolling sideways instead of wrapping.
struct CodeDiffView: View {
    let path: String
    let old: String
    let new: String
    let layout: DiffLayout
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let hunks = DiffHunks.build(old: old, new: new)
        let metrics = CodeMetrics(dynamicTypeSize)
        Group {
            switch layout {
            case .unified:
                ScrollView(.horizontal) {
                    let width = rowWidth(hunks.flatMap(\.lines), numberColumns: 2, visible: visibleWidth, metrics: metrics)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(hunks) { hunk in
                            HunkHeaderRow(header: hunk.header, numberColumns: 2, metrics: metrics).frame(width: width, alignment: .leading)
                            ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                                CodeRow(path: path, line: line, numbers: [line.oldNumber, line.newNumber], metrics: metrics).frame(width: width, alignment: .leading)
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
            case .split:
                HStack(alignment: .top, spacing: 0) {
                    side(hunks, old: true, metrics: metrics)
                    Rectangle().fill(Palette.border).frame(width: 1.5)
                    side(hunks, old: false, metrics: metrics)
                }
            }
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { visibleWidth = $0 }
    }

    @State private var visibleWidth: CGFloat = 0

    /// One side of the split view; rows the other side changed stay blank so both sides line up.
    private func side(_ hunks: [DiffHunks.Hunk], old: Bool, metrics: CodeMetrics) -> some View {
        let pairs = hunks.map { ($0.header, SplitRows.pair($0.lines)) }
        let width = rowWidth(pairs.flatMap { $0.1.compactMap { old ? $0.old : $0.new } }, numberColumns: 1, visible: max(0, (visibleWidth - 1.5) / 2), metrics: metrics)
        return ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(pairs, id: \.0) { header, rows in
                    HunkHeaderRow(header: header, numberColumns: 1, metrics: metrics).frame(width: width, alignment: .leading)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, pair in
                        if let line = old ? pair.old : pair.new {
                            CodeRow(path: path, line: line, numbers: [old ? line.oldNumber : line.newNumber], metrics: metrics, dimsContextNumber: true)
                                .frame(width: width, alignment: .leading)
                        } else {
                            Palette.bg.frame(width: width, height: metrics.lineHeight)
                        }
                    }
                }
            }
        }
        .scrollIndicators(.hidden)
        .frame(maxWidth: .infinity)
    }
}

/// Lines of a hunk paired for the split view: removals beside the additions that replaced them.
enum SplitRows {
    struct Pair { var old: DiffHunks.Line?; var new: DiffHunks.Line? }

    static func pair(_ lines: [DiffHunks.Line]) -> [Pair] {
        var pairs: [Pair] = []
        var removed: [DiffHunks.Line] = [], added: [DiffHunks.Line] = []
        func flush() {
            for index in 0..<max(removed.count, added.count) {
                pairs.append(Pair(old: index < removed.count ? removed[index] : nil, new: index < added.count ? added[index] : nil))
            }
            removed = []
            added = []
        }
        for line in lines {
            switch line.kind {
            case .removed: removed.append(line)
            case .added: added.append(line)
            case .context:
                flush()
                pairs.append(Pair(old: line, new: line))
            }
        }
        flush()
        return pairs
    }
}

private struct HunkHeaderRow: View {
    let header: String
    let numberColumns: Int
    let metrics: CodeMetrics

    var body: some View {
        HStack(spacing: 0) {
            ForEach(0..<numberColumns, id: \.self) { _ in Color.clear.frame(width: metrics.numberColumnWidth) }
            Text(header).padding(.leading, 4).padding(.trailing, 10)
        }
        .font(metrics.font)
        .foregroundStyle(Palette.t300)
        .frame(height: metrics.lineHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.bg90)
    }
}

/// `.dl`: line numbers, the +/- marker and the highlighted text.
private struct CodeRow: View {
    let path: String
    let line: DiffHunks.Line
    let numbers: [Int?]
    let metrics: CodeMetrics
    var dimsContextNumber = false

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(numbers.enumerated()), id: \.offset) { _, number in
                Text(number.map(String.init) ?? "")
                    .foregroundStyle(Palette.t300)
                    .opacity(dimsContextNumber && line.kind == .context ? 0.5 : 1)
                    .frame(width: metrics.numberColumnWidth - 6, alignment: .trailing)
                    .padding(.trailing, 6)
                    .frame(maxHeight: .infinity)
                    .background(numberBackground)
            }
            highlighted
                .lineLimit(1)
                .fixedSize()
                .padding(.leading, 4)
                .padding(.trailing, 10)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .background(lineBackground)
        }
        .font(metrics.font)
        .frame(height: metrics.lineHeight)
        .background(line.kind == .context ? Palette.bg90 : Palette.bg)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        switch line.kind {
        case .added: return "Added: " + line.text
        case .removed: return "Removed: " + line.text
        case .context: return line.text
        }
    }

    private var marker: String {
        switch line.kind {
        case .added: return "+"
        case .removed: return "-"
        case .context: return " "
        }
    }

    private var highlighted: Text {
        SyntaxTokens.tokenize(line.text, path: path).reduce(Text(marker).foregroundColor(Palette.fg)) { text, token in
            text + Text(token.text).foregroundColor(Palette.syntax(token.kind))
        }
    }

    private var lineBackground: Color {
        switch line.kind {
        case .added: return Palette.diffAddedLine
        case .removed: return Palette.diffRemovedLine
        case .context: return .clear
        }
    }

    private var numberBackground: Color {
        switch line.kind {
        case .added: return Palette.diffAddedNumber
        case .removed: return Palette.diffRemovedNumber
        case .context: return .clear
        }
    }
}

/// The document diff of prose files (MergeDiffEditor): every line, numbered,
/// additions and deletions tinted in place; Split puts the base on the left.
struct ProseDiffView: View {
    let old: String
    let new: String
    let layout: DiffLayout

    var body: some View {
        let rows = DiffHunks.document(old: old, new: new)
        switch layout {
        case .unified:
            column(rows, number: { $0.kind == .removed ? $0.oldNumber : $0.newNumber })
        case .split:
            HStack(alignment: .top, spacing: 0) {
                column(rows.filter { $0.kind != .added }, number: \.oldNumber).frame(maxWidth: .infinity, alignment: .top)
                Rectangle().fill(Palette.border).frame(width: 1.5)
                column(rows.filter { $0.kind != .removed }, number: \.newNumber).frame(maxWidth: .infinity, alignment: .top)
            }
        }
    }

    private func column(_ rows: [DiffHunks.Line], number: @escaping (DiffHunks.Line) -> Int?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text(number(row).map(String.init) ?? "")
                        .textStyle(TextStyle(size: 12))
                        .foregroundStyle(Palette.t400)
                        .frame(minWidth: 26, alignment: .leading)
                    Text(row.text.isEmpty ? " " : row.text)
                        .textStyle(TextStyle(size: 14, lineHeight: 1.6))
                        .foregroundStyle(Palette.fg)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 14)
                .background(row.kind == .added ? Palette.diffAddedLine : row.kind == .removed ? Palette.diffRemovedLine : .clear)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.vertical, 8)
    }
}
