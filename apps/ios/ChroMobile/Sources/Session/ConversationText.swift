import ChroDomain
import SwiftUI

/// The live label's sweep (components/text-shimmer.tsx): #a1a1aa text with a
/// dark highlight crossing it left to right every 2 seconds.
struct TextShimmer: View {
    let text: String
    var style: TextStyle = TextStyle(size: 14, weight: 500)

    var body: some View {
        TimelineView(.animation) { context in
            let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2) / 2
            Text(text)
                .textStyle(style)
                .lineLimit(1)
                .foregroundStyle(Palette.shimmerBase)
                .overlay {
                    GeometryReader { proxy in
                        let width = proxy.size.width
                        let gradientWidth = width * ConversationLayout.shimmerGradientScale
                        LinearGradient(stops: [.init(color: .clear, location: 0.4), .init(color: Palette.fg, location: 0.5), .init(color: .clear, location: 0.6)],
                                       startPoint: .leading, endPoint: .trailing)
                            .frame(width: gradientWidth)
                            .offset(x: ConversationLayout.shimmerHighlightCenter(width: width, phase: phase) - gradientWidth / 2)
                    }
                    .mask(Text(text).textStyle(style).lineLimit(1))
                    .allowsHitTesting(false)
                }
        }
        .accessibilityLabel(text)
    }
}

/// components/braille-spinner.tsx: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏, one frame every 90 ms.
struct BrailleSpinner: View {
    private static let frames = Array("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.09)) { context in
            let frame = Int(context.date.timeIntervalSinceReferenceDate / 0.09) % Self.frames.count
            Text(String(Self.frames[frame]))
                .textStyle(.code(14))
                .foregroundStyle(Palette.t300.opacity(0.9))
        }
        .accessibilityHidden(true)
    }
}

/// Which find match is current, for highlighting text nodes.
struct FindHighlight: Equatable {
    var query: String
    /// The active match's index among this entry's matches.
    var activeLocalIndex: Int?
}

/// Builds attributed text from inline runs, highlighting find matches text node by text node.
struct InlineTextBuilder {
    var size: CGFloat
    /// The reader's text size: every font the builder makes scales with it.
    var dynamicTypeSize: DynamicTypeSize
    var weight: CGFloat = 400
    var color: Color = Palette.fg
    var highlight: FindHighlight?
    /// Inline code spans that name an existing file or folder (path links); they carry a link.
    var linkedSpans: Set<String> = []
    /// Matches already counted in earlier text nodes of the same entry.
    private(set) var ordinal = 0

    init(size: CGFloat, dynamicTypeSize: DynamicTypeSize, weight: CGFloat = 400, color: Color = Palette.fg, highlight: FindHighlight?, startOrdinal: Int = 0) {
        self.size = size
        self.dynamicTypeSize = dynamicTypeSize
        self.weight = weight
        self.color = color
        self.highlight = highlight
        ordinal = startOrdinal
    }

    /// Inter at a mock size and weight, scaled to the reader's text size.
    func font(_ size: CGFloat, weight: CGFloat = 400) -> Font { TextStyle(size: size, weight: weight).font(dynamicTypeSize) }

    /// The monospaced face at a mock size, scaled to the reader's text size.
    func codeFont(_ size: CGFloat) -> Font { TextStyle.code(size).font(dynamicTypeSize) }

    /// A mock size at the reader's text size (for line spacing).
    func scaled(_ size: CGFloat) -> CGFloat { TextStyle(size: size).scaledSize(dynamicTypeSize) }

    mutating func build(_ runs: [MarkdownDocument.Inline]) -> AttributedString {
        runs.reduce(into: AttributedString()) { result, run in result += build(run, weight: weight, color: color) }
    }

    private mutating func build(_ run: MarkdownDocument.Inline, weight: CGFloat, color: Color) -> AttributedString {
        switch run {
        case .text(let text):
            return leaf(text, font: font(size, weight: weight), color: color)
        case .code(let text):
            // markdown.tsx: a code span the desktop confirmed as a path reads blue and opens it.
            if linkedSpans.contains(text), let url = PathLinks.url(for: text) {
                var piece = leaf(text, font: codeFont(size - 2), color: Palette.blue600)
                piece.link = url
                piece.mergeAttributes(AttributeContainer().backgroundColor(Palette.muted), mergePolicy: .keepCurrent)
                return piece
            }
            var piece = leaf(text, font: codeFont(size - 2), color: color)
            piece.mergeAttributes(AttributeContainer().backgroundColor(Palette.muted), mergePolicy: .keepCurrent)
            return piece
        case .strong(let inner):
            return inner.reduce(into: AttributedString()) { $0 += build($1, weight: 600, color: color) }
        case .emphasis(let inner):
            return inner.reduce(into: AttributedString()) { $0 += build($1, weight: weight, color: color.opacity(0.8)) }
        case .link(let text, let url):
            var piece = text.reduce(into: AttributedString()) { $0 += build($1, weight: 500, color: Palette.blue600) }
            if let link = URL(string: url), link.scheme == "http" || link.scheme == "https" { piece.link = link }
            return piece
        case .lineBreak:
            return AttributedString("\n")
        }
    }

    /// One text node: plain text with its find matches tinted.
    mutating func leaf(_ text: String, font: Font, color: Color) -> AttributedString {
        var piece = AttributedString(text)
        piece.font = font
        piece.foregroundColor = color
        guard let highlight else { return piece }
        for range in ConversationFind.ranges(of: highlight.query, in: text) {
            let active = highlight.activeLocalIndex == ordinal
            ordinal += 1
            guard let lower = AttributedString.Index(range.lowerBound, within: piece),
                  let upper = AttributedString.Index(range.upperBound, within: piece) else { continue }
            piece[lower..<upper].backgroundColor = Palette.primary.opacity(active ? 0.5 : 0.25)
        }
        return piece
    }
}

/// Assistant text (components/markdown.tsx): paragraphs, headings, lists,
/// quotes, code blocks, tables and rules at the conversation's reading size.
struct MarkdownView: View {
    let markdown: String
    var size: CGFloat = 15
    var color: Color = Palette.fg
    var highlight: FindHighlight?

    @Environment(\.externalScreens) private var external
    @Environment(\.pathLinkScope) private var pathLinkScope
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(Router.self) private var router
    @Environment(SheetPresenter.self) private var sheets

    private var pathLinks: PathLinkContext { PathLinkContext(links: external.pathLinks, scope: pathLinkScope) }

    var body: some View {
        let document = MarkdownDocument.parse(markdown)
        var ordinal = 0
        let rendered: [(MarkdownDocument.Block, Int)] = document.blocks.map { block in
            let start = ordinal
            if let highlight {
                for node in MarkdownDocument.textNodes(of: block) { ordinal += ConversationFind.ranges(of: highlight.query, in: node).count }
            }
            return (block, start)
        }
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(rendered.enumerated()), id: \.offset) { _, item in
                blockView(item.0, startOrdinal: item.1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .openingPathLinks(pathLinks, router: router, sheets: sheets, external: external)
        // markdown.tsx waits 150 ms for streamed text to settle before probing its code spans.
        .task(id: PathLinkTask(markdown: markdown, scope: pathLinkScope)) {
            guard external.pathLinks != nil, pathLinkScope != nil, (try? await Task.sleep(for: .milliseconds(150))) != nil else { return }
            await pathLinks.resolve(Self.codeSpans(MarkdownDocument.parse(markdown)))
        }
    }

    private func text(_ runs: [MarkdownDocument.Inline], size: CGFloat? = nil, weight: CGFloat = 400, startOrdinal: Int) -> Text {
        var builder = InlineTextBuilder(size: size ?? self.size, dynamicTypeSize: dynamicTypeSize, weight: weight, color: color, highlight: highlight, startOrdinal: startOrdinal)
        builder.linkedSpans = pathLinks.resolved(Self.codeSpans(runs))
        return Text(builder.build(runs))
    }

    /// Every inline code span of the document; code blocks are never probed.
    static func codeSpans(_ runs: [MarkdownDocument.Inline]) -> [String] {
        runs.flatMap { run -> [String] in
            switch run {
            case .code(let text): return [text]
            case .strong(let inner), .emphasis(let inner): return codeSpans(inner)
            case .link(let text, _): return codeSpans(text)
            case .text, .lineBreak: return []
            }
        }
    }

    static func codeSpans(_ document: MarkdownDocument) -> [String] {
        let spans = codeSpans as ([MarkdownDocument.Inline]) -> [String]
        return document.blocks.flatMap { block -> [String] in
            switch block {
            case .paragraph(let runs), .heading(_, let runs), .quote(let runs): return spans(runs)
            case .list(_, _, let items): return items.flatMap { spans($0.content) }
            case .table(let header, let rows): return (header + rows.flatMap { $0 }).flatMap(spans)
            case .code, .rule: return []
            }
        }
    }

    private var lineSpacing: CGFloat { TextStyle(size: size).scaledSize(dynamicTypeSize) * 0.625 - 3 }

    @ViewBuilder private func blockView(_ block: MarkdownDocument.Block, startOrdinal: Int) -> some View {
        switch block {
        case .paragraph(let runs):
            text(runs, startOrdinal: startOrdinal).lineSpacing(lineSpacing).fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let runs):
            text(runs, size: [20, 18, 16, 16, 14, 14][min(level, 6) - 1], weight: 600, startOrdinal: startOrdinal)
                .padding(.top, level <= 2 ? 6 : 2)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { offset, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let checked = item.checked {
                            Image(systemName: checked ? "checkmark.square" : "square").textStyle(TextStyle(size: size - 2)).foregroundStyle(color)
                        } else {
                            Text(ordered ? "\(start + offset)." : "•").textStyle(TextStyle(size: size)).foregroundStyle(color)
                                .frame(minWidth: 14, alignment: .trailing)
                        }
                        text(item.content, startOrdinal: itemOrdinal(items, before: offset, start: startOrdinal))
                            .lineSpacing(lineSpacing).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.leading, 4)
        case .quote(let runs):
            text(runs, startOrdinal: startOrdinal).lineSpacing(lineSpacing).opacity(0.8)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(Palette.t300.opacity(0.4)).frame(width: 2) }
        case .code(_, let code):
            ScrollView(.horizontal, showsIndicators: false) {
                var builder = InlineTextBuilder(size: 12, dynamicTypeSize: dynamicTypeSize, color: color, highlight: highlight, startOrdinal: startOrdinal)
                Text(builder.leaf(code, font: builder.codeFont(12), color: color)).lineSpacing(4).padding(12)
            }
            .background(RoundedRectangle(cornerRadius: 6).fill(Palette.muted))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.border.opacity(0.5)))
        case .table(let header, let rows):
            let ordinals = tableOrdinals(header: header, rows: rows, start: startOrdinal)
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow {
                        ForEach(Array(header.enumerated()), id: \.offset) { column, cell in
                            text(cell, size: 12, weight: 600, startOrdinal: ordinals[0][column])
                                .textCase(.uppercase)
                                .foregroundStyle(Palette.t300).padding(.horizontal, 14).padding(.vertical, 10).frame(minWidth: 120, alignment: .leading)
                        }
                    }
                    .background(Palette.muted)
                    ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, row in
                        Divider().gridCellUnsizedAxes(.horizontal)
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                                text(cell, size: 14, startOrdinal: ordinals[rowIndex + 1][column])
                                    .padding(.horizontal, 14).padding(.vertical, 10).frame(minWidth: 120, alignment: .leading)
                            }
                        }
                    }
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        case .rule:
            Rectangle().fill(Palette.muted).frame(height: 1).padding(.vertical, 12)
        }
    }

    /// The first match ordinal of every cell, header row first.
    private func tableOrdinals(header: [[MarkdownDocument.Inline]], rows: [[[MarkdownDocument.Inline]]], start: Int) -> [[Int]] {
        var running = start
        return ([header] + rows).map { row in
            row.map { cell in
                let first = running
                if let highlight { running += MarkdownDocument.leaves(cell).reduce(0) { $0 + ConversationFind.ranges(of: highlight.query, in: $1).count } }
                return first
            }
        }
    }

    private func itemOrdinal(_ items: [MarkdownDocument.ListItem], before index: Int, start: Int) -> Int {
        guard let highlight else { return start }
        return start + items.prefix(index).flatMap { MarkdownDocument.leaves($0.content) }
            .reduce(0) { $0 + ConversationFind.ranges(of: highlight.query, in: $1).count }
    }
}

/// What a message's path probe depends on: its text and where it resolves.
private struct PathLinkTask: Equatable {
    var markdown: String
    var scope: PathLinks.Scope?
}
