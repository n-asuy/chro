import Foundation

/// An assistant message as blocks and inline runs: the subset of GFM the
/// desktop's Markdown component renders, with remark-breaks (a single newline
/// is a line break).
public struct MarkdownDocument: Equatable, Sendable {
    public indirect enum Inline: Equatable, Sendable, Hashable {
        case text(String)
        case strong([Inline])
        case emphasis([Inline])
        case code(String)
        case link(text: [Inline], url: String)
        case lineBreak
    }

    public struct ListItem: Equatable, Sendable, Hashable {
        public var content: [Inline]
        /// A task list item: checked or not; nil for a plain item.
        public var checked: Bool?

        public init(content: [Inline], checked: Bool? = nil) {
            self.content = content
            self.checked = checked
        }
    }

    public enum Block: Equatable, Sendable, Hashable {
        case paragraph([Inline])
        case heading(level: Int, [Inline])
        case list(ordered: Bool, start: Int, items: [ListItem])
        case quote([Inline])
        case code(language: String?, text: String)
        case table(header: [[Inline]], rows: [[[Inline]]])
        case rule
    }

    public var blocks: [Block]

    public init(blocks: [Block]) { self.blocks = blocks }

    // MARK: Blocks

    public static func parse(_ source: String) -> MarkdownDocument {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [Block] = []
        var index = 0
        var paragraph: [String] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(inlineLines(paragraph)))
            paragraph = []
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                flushParagraph()
                index += 1
            } else if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let fence = String(trimmed.prefix(3))
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                index += 1
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    body.append(lines[index])
                    index += 1
                }
                index += 1
                blocks.append(.code(language: language.isEmpty ? nil : language, text: body.joined(separator: "\n")))
            } else if let heading = headingLevel(trimmed) {
                flushParagraph()
                blocks.append(.heading(level: heading, parseInline(String(trimmed.drop { $0 == "#" }).trimmingCharacters(in: .whitespaces))))
                index += 1
            } else if isRule(trimmed) {
                flushParagraph()
                blocks.append(.rule)
                index += 1
            } else if trimmed.hasPrefix(">") {
                flushParagraph()
                var quoted: [String] = []
                while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    quoted.append(String(lines[index].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces))
                    index += 1
                }
                blocks.append(.quote(inlineLines(quoted)))
            } else if let marker = listMarker(line) {
                flushParagraph()
                var items: [(ListItem, [String])] = []
                let ordered = marker.ordered
                while index < lines.count {
                    let current = lines[index]
                    if let next = listMarker(current), next.ordered == ordered, isTask(next.rest) == isTask(marker.rest) {
                        items.append((ListItem(content: [], checked: taskState(next.rest)), [taskText(next.rest)]))
                        index += 1
                    } else if !current.trimmingCharacters(in: .whitespaces).isEmpty, current.hasPrefix(" ") || current.hasPrefix("\t"), !items.isEmpty,
                              listMarker(current) == nil {
                        items[items.count - 1].1.append(current.trimmingCharacters(in: .whitespaces))
                        index += 1
                    } else {
                        break
                    }
                }
                blocks.append(.list(ordered: ordered, start: marker.start, items: items.map { item, text in
                    ListItem(content: inlineLines(text), checked: item.checked)
                }))
            } else if trimmed.hasPrefix("|"), index + 1 < lines.count, isTableDivider(lines[index + 1]) {
                flushParagraph()
                let header = tableCells(trimmed)
                var rows: [[[Inline]]] = []
                index += 2
                while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(tableCells(lines[index].trimmingCharacters(in: .whitespaces)).map(parseInline))
                    index += 1
                }
                blocks.append(.table(header: header.map(parseInline), rows: rows))
            } else {
                paragraph.append(trimmed)
                index += 1
            }
        }
        flushParagraph()
        return MarkdownDocument(blocks: blocks)
    }

    private static func inlineLines(_ lines: [String]) -> [Inline] {
        var result: [Inline] = []
        for (offset, line) in lines.enumerated() {
            if offset > 0 { result.append(.lineBreak) }
            result += parseInline(line)
        }
        return result
    }

    private static func headingLevel(_ line: String) -> Int? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), line.count > hashes, line[line.index(line.startIndex, offsetBy: hashes)] == " " else { return nil }
        return hashes
    }

    private static func isRule(_ line: String) -> Bool {
        let compact = line.replacingOccurrences(of: " ", with: "")
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    private struct ListMarker: Equatable {
        var ordered: Bool
        var start: Int
        var rest: String
    }

    private static func listMarker(_ line: String) -> ListMarker? {
        let trimmed = line.drop { $0 == " " }
        guard line.count - trimmed.count < 2 else { return nil }
        if let first = trimmed.first, "-*+".contains(first), trimmed.dropFirst().first == " " {
            return ListMarker(ordered: false, start: 1, rest: String(trimmed.dropFirst(2)))
        }
        let digits = trimmed.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count <= 9 {
            let after = trimmed.dropFirst(digits.count)
            if let dot = after.first, dot == "." || dot == ")", after.dropFirst().first == " " {
                return ListMarker(ordered: true, start: Int(digits) ?? 1, rest: String(after.dropFirst(2)))
            }
        }
        return nil
    }

    private static func isTask(_ text: String) -> Bool { taskState(text) != nil }

    private static func taskState(_ text: String) -> Bool? {
        if text.hasPrefix("[ ] ") { return false }
        if text.lowercased().hasPrefix("[x] ") { return true }
        return nil
    }

    private static func taskText(_ text: String) -> String { isTask(text) ? String(text.dropFirst(4)) : text }

    private static func isTableDivider(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("|"), trimmed.contains("-") else { return false }
        return trimmed.allSatisfy { "|-: ".contains($0) }
    }

    private static func tableCells(_ line: String) -> [String] {
        var body = line
        if body.hasPrefix("|") { body.removeFirst() }
        if body.hasSuffix("|") { body.removeLast() }
        return body.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    // MARK: Inline

    public static func parseInline(_ text: String) -> [Inline] {
        var output: [Inline] = []
        var buffer = ""
        let chars = Array(text)
        var i = 0

        func flush() {
            if !buffer.isEmpty { output.append(.text(buffer)); buffer = "" }
        }

        func find(_ marker: String, from start: Int) -> Int? {
            let m = Array(marker)
            var j = start
            while j + m.count <= chars.count {
                if chars[j] == "`" && marker != "`" {
                    // Skip a code span; markers inside it are literal.
                    if let close = (j + 1..<chars.count).first(where: { chars[$0] == "`" }) { j = close + 1; continue }
                }
                if Array(chars[j..<j + m.count]) == m { return j }
                j += 1
            }
            return nil
        }

        while i < chars.count {
            let c = chars[i]
            if c == "`", let close = find("`", from: i + 1), close > i + 1 {
                flush()
                output.append(.code(String(chars[i + 1..<close])))
                i = close + 1
            } else if c == "*" || c == "_", i + 1 < chars.count, chars[i + 1] == c, let close = find(String([c, c]), from: i + 2), close > i + 2 {
                flush()
                output.append(.strong(parseInline(String(chars[i + 2..<close]))))
                i = close + 2
            } else if (c == "*" || c == "_"), i + 1 < chars.count, !chars[i + 1].isWhitespace, chars[i + 1] != c,
                      let close = find(String(c), from: i + 1), close > i + 1, !chars[close - 1].isWhitespace,
                      c == "*" || i == 0 || !(chars[i - 1].isLetter || chars[i - 1].isNumber) {
                flush()
                output.append(.emphasis(parseInline(String(chars[i + 1..<close]))))
                i = close + 1
            } else if c == "[", let closeText = find("]", from: i + 1), closeText + 1 < chars.count, chars[closeText + 1] == "(",
                      let closeURL = (closeText + 2..<chars.count).first(where: { chars[$0] == ")" }) {
                flush()
                output.append(.link(text: parseInline(String(chars[i + 1..<closeText])), url: String(chars[closeText + 2..<closeURL])))
                i = closeURL + 1
            } else {
                buffer.append(c)
                i += 1
            }
        }
        flush()
        return output
    }

    // MARK: Plain text

    /// The text a reader sees, for find and copy-free comparisons.
    public var plainText: String {
        blocks.map { block -> String in
            switch block {
            case .paragraph(let inline), .heading(_, let inline), .quote(let inline): return Self.plain(inline)
            case .list(_, _, let items): return items.map { Self.plain($0.content) }.joined(separator: "\n")
            case .code(_, let text): return text
            case .table(let header, let rows): return ([header] + rows).map { $0.map(Self.plain).joined(separator: " ") }.joined(separator: "\n")
            case .rule: return ""
            }
        }.joined(separator: "\n\n")
    }

    public static func plain(_ inline: [Inline]) -> String {
        inline.map { run -> String in
            switch run {
            case .text(let text), .code(let text): return text
            case .strong(let inner), .emphasis(let inner): return plain(inner)
            case .link(let text, _): return plain(text)
            case .lineBreak: return "\n"
            }
        }.joined()
    }
}
