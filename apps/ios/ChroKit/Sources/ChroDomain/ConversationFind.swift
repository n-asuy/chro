import Foundation

/// "Find in conversation": case-insensitive matches in the text the reader
/// sees (prompt text, assistant messages, error cards), counted text node by
/// text node in display order, as the desktop's highlighter walks the DOM.
public enum ConversationFind {
    public struct Match: Equatable, Sendable, Hashable {
        public var entryID: String
        /// The match's position among its entry's matches.
        public var localIndex: Int

        public init(entryID: String, localIndex: Int) {
            self.entryID = entryID
            self.localIndex = localIndex
        }
    }

    /// Non-overlapping, case-insensitive occurrences of `query` in `text`.
    public static func ranges(of query: String, in text: String) -> [Range<String.Index>] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }
        var found: [Range<String.Index>] = []
        var start = text.startIndex
        while start < text.endIndex, let range = text.range(of: needle, options: [.caseInsensitive], range: start..<text.endIndex) {
            found.append(range)
            start = range.upperBound
        }
        return found
    }

    /// The text nodes of an entry, in the order they render.
    public static func textNodes(of kind: ConversationEntryKind) -> [String] {
        switch kind {
        case .userMessage(let content): return [PromptContent.parse(content).text]
        case .assistantMessage(let markdown): return MarkdownDocument.parse(markdown).textNodes
        case .errorMessage(let text, _): return [text]
        default: return []
        }
    }

    /// Every match, in display order.
    public static func matches(query: String, in entries: [ConversationEntry]) -> [Match] {
        entries.flatMap { entry -> [Match] in
            let count = textNodes(of: entry.kind).reduce(0) { $0 + ranges(of: query, in: $1).count }
            return (0..<count).map { Match(entryID: entry.id, localIndex: $0) }
        }
    }

    /// `{current}/{total}`, with nothing found reading `0/0`.
    public static func counter(current: Int, total: Int) -> String { total == 0 ? "0/0" : "\(current + 1)/\(total)" }

    /// The next match index, wrapping both ways.
    public static func step(_ current: Int, by delta: Int, total: Int) -> Int {
        guard total > 0 else { return 0 }
        return ((current + delta) % total + total) % total
    }
}

extension MarkdownDocument {
    /// Text and code leaves in render order.
    public var textNodes: [String] { blocks.flatMap(Self.textNodes(of:)) }

    /// One block's text nodes; a table's run header first, then row by row.
    public static func textNodes(of block: Block) -> [String] {
        switch block {
        case .paragraph(let inline), .heading(_, let inline), .quote(let inline): return leaves(inline)
        case .list(_, _, let items): return items.flatMap { leaves($0.content) }
        case .code(_, let text): return [text]
        case .table(let header, let rows): return (header + rows.flatMap { $0 }).flatMap(leaves)
        case .rule: return []
        }
    }

    public static func leaves(_ inline: [Inline]) -> [String] {
        inline.flatMap { run -> [String] in
            switch run {
            case .text(let text), .code(let text): return [text]
            case .strong(let inner), .emphasis(let inner): return leaves(inner)
            case .link(let text, _): return leaves(text)
            case .lineBreak: return []
            }
        }
    }
}
