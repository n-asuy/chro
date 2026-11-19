import Foundation

/// One markdown line as the prose editor renders it when it is not being
/// edited (the mock's `proseLine`; the desktop's live-preview decorations).
public enum ProseBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    case task(checked: Bool, text: String)
    case bullet(text: String)
    case ordered(number: Int, text: String)
    case paragraph(text: String)

    public init(line: String) {
        if let match = line.firstMatch(of: /^(#{1,6})\s+(.*)$/) {
            self = .heading(level: match.1.count, text: String(match.2))
        } else if let match = line.firstMatch(of: /^- \[( |x|X)\] (.*)$/) {
            self = .task(checked: match.1 != " ", text: String(match.2))
        } else if let match = line.firstMatch(of: /^[-*] (.*)$/) {
            self = .bullet(text: String(match.1))
        } else if let match = line.firstMatch(of: /^(\d+)\. (.*)$/), let number = Int(match.1) {
            self = .ordered(number: number, text: String(match.2))
        } else {
            self = .paragraph(text: line)
        }
    }
}

/// Inline markdown of a rendered prose line.
public enum ProseInline: Equatable, Sendable {
    case text(String)
    case code(String)
    case bold(String)
    case italic(String)
    case strike(String)
    case highlight(String)
    /// `[[target]]` or `[[target|label]]`; opens the resolved note.
    case wikilink(target: String, label: String)
    /// `[label](url)`.
    case link(label: String, url: String)
    /// A bare `http(s)://` URL.
    case url(String)

    public static func parse(_ text: String) -> [ProseInline] {
        var spans: [ProseInline] = []
        var plain = ""
        var rest = Substring(text)
        func flush() {
            if !plain.isEmpty { spans.append(.text(plain)); plain = "" }
        }
        while !rest.isEmpty {
            if let match = rest.prefixMatch(of: /`([^`]+)`/) {
                flush(); spans.append(.code(String(match.1))); rest = rest[match.range.upperBound...]
            } else if let match = rest.prefixMatch(of: /\*\*([^*]+)\*\*/) {
                flush(); spans.append(.bold(String(match.1))); rest = rest[match.range.upperBound...]
            } else if let match = rest.prefixMatch(of: /~~([^~]+)~~/) {
                flush(); spans.append(.strike(String(match.1))); rest = rest[match.range.upperBound...]
            } else if let match = rest.prefixMatch(of: /==([^=]+)==/) {
                flush(); spans.append(.highlight(String(match.1))); rest = rest[match.range.upperBound...]
            } else if let match = rest.prefixMatch(of: /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/) {
                flush()
                let target = String(match.1)
                spans.append(.wikilink(target: target, label: match.2.map(String.init) ?? target))
                rest = rest[match.range.upperBound...]
            } else if let match = rest.prefixMatch(of: /\[([^\]]+)\]\(([^)\s]+)\)/) {
                flush(); spans.append(.link(label: String(match.1), url: String(match.2))); rest = rest[match.range.upperBound...]
            } else if let match = rest.prefixMatch(of: /https?:\/\/[^\s<>()]+/) {
                flush(); spans.append(.url(String(match.0))); rest = rest[match.range.upperBound...]
            } else if let match = rest.prefixMatch(of: /(\*|_)([^*_\s][^*_]*)\1/), plain.last.map({ !$0.isLetter && !$0.isNumber }) ?? true {
                flush(); spans.append(.italic(String(match.2))); rest = rest[match.range.upperBound...]
            } else {
                plain.append(rest.removeFirst())
            }
        }
        flush()
        return spans
    }
}

/// Line editing of the prose editor: a focused line edits its markdown source.
public enum ProseEditing {
    public struct Result: Equatable, Sendable {
        public var lines: [String]
        /// The line that keeps focus and the caret offset in it (characters).
        public var line: Int
        public var offset: Int

        public init(lines: [String], line: Int, offset: Int) {
            self.lines = lines
            self.line = line
            self.offset = offset
        }
    }

    public struct Wrapped: Equatable, Sendable {
        public var text: String
        public var selection: Range<Int>

        public init(text: String, selection: Range<Int>) {
            self.text = text
            self.selection = selection
        }
    }

    /// Enter: splits the line at the caret and continues a list or task marker
    /// (a checked task continues unchecked, an ordered item counts up). Enter on
    /// an item with only its marker ends the list instead.
    public static func split(lines: [String], line: Int, offset: Int) -> Result {
        guard lines.indices.contains(line) else { return Result(lines: lines, line: line, offset: offset) }
        let text = lines[line]
        let marker = listMarker(of: text)
        var updated = lines
        if let marker, text == marker.prefix {
            updated[line] = ""
            return Result(lines: updated, line: line, offset: 0)
        }
        let cut = text.index(text.startIndex, offsetBy: min(max(0, offset), text.count))
        let continuation = marker?.next ?? ""
        updated[line] = String(text[..<cut])
        updated.insert(continuation + String(text[cut...]), at: line + 1)
        return Result(lines: updated, line: line + 1, offset: continuation.count)
    }

    /// Backspace at the start of a line joins it onto the previous one.
    public static func join(lines: [String], line: Int) -> Result {
        guard line > 0, lines.indices.contains(line) else { return Result(lines: lines, line: line, offset: 0) }
        var updated = lines
        let previous = updated[line - 1]
        updated[line - 1] = previous + updated[line]
        updated.remove(at: line)
        return Result(lines: updated, line: line - 1, offset: previous.count)
    }

    public static func toggleTask(_ line: String) -> String {
        guard let match = line.prefixMatch(of: /- \[( |x|X)\]/) else { return line }
        return (match.1 == " " ? "- [x]" : "- [ ]") + line[match.range.upperBound...]
    }

    /// Bold, italic, strike, code and highlight: wraps the selection in `marker`.
    public static func wrap(_ text: String, selection: Range<Int>, marker: String) -> Wrapped {
        let (head, selected, tail) = parts(text, selection)
        let shift = marker.count
        return Wrapped(text: head + marker + selected + marker + tail,
                       selection: (selection.lowerBound + shift)..<(selection.upperBound + shift))
    }

    /// Insert Link: `[selection](https://)` with the URL selected.
    public static func link(_ text: String, selection: Range<Int>) -> Wrapped {
        let (head, selected, tail) = parts(text, selection)
        let inserted = "[\(selected)](https://)"
        let urlStart = head.count + selected.count + 3
        return Wrapped(text: head + inserted + tail, selection: urlStart..<(urlStart + "https://".count))
    }

    private static func parts(_ text: String, _ selection: Range<Int>) -> (String, String, String) {
        let lower = text.index(text.startIndex, offsetBy: min(max(0, selection.lowerBound), text.count))
        let upper = text.index(text.startIndex, offsetBy: min(max(selection.lowerBound, selection.upperBound), text.count))
        return (String(text[..<lower]), String(text[lower..<upper]), String(text[upper...]))
    }

    private static func listMarker(of line: String) -> (prefix: String, next: String)? {
        if let match = line.prefixMatch(of: /- \[( |x|X)\][ ]/) { return (String(match.0), "- [ ] ") }
        if let match = line.prefixMatch(of: /[-*][ ]/) { return (String(match.0), String(match.0)) }
        if let match = line.prefixMatch(of: /(\d+)\.[ ]/), let number = Int(match.1) { return (String(match.0), "\(number + 1). ") }
        return nil
    }
}

/// Find in file: case-insensitive matches of a query, line by line.
public enum FindInText {
    public struct Match: Equatable, Sendable {
        public var line: Int
        /// Character offsets in the line.
        public var range: Range<Int>

        public init(line: Int, range: Range<Int>) {
            self.line = line
            self.range = range
        }
    }

    public static func matches(of query: String, in lines: [String]) -> [Match] {
        guard !query.isEmpty else { return [] }
        var result: [Match] = []
        for (number, line) in lines.enumerated() {
            var searchStart = line.startIndex
            while let found = line.range(of: query, options: [.caseInsensitive], range: searchStart..<line.endIndex), !found.isEmpty {
                let lower = line.distance(from: line.startIndex, to: found.lowerBound)
                result.append(Match(line: number, range: lower..<(lower + line.distance(from: found.lowerBound, to: found.upperBound))))
                searchStart = found.upperBound
            }
        }
        return result
    }

    /// Next/previous match index, wrapping.
    public static func step(_ index: Int, by delta: Int, count: Int) -> Int {
        guard count > 0 else { return 0 }
        return ((index + delta) % count + count) % count
    }

    /// The find bar's `current/total`, empty while the query is empty.
    public static func counter(index: Int, count: Int, query: String) -> String {
        guard !query.isEmpty else { return "" }
        return count == 0 ? "0/0" : "\(index % count + 1)/\(count)"
    }
}

/// A size without CoreGraphics, for the pure fit computation.
public struct CGSizeValue: Equatable, Sendable {
    public var width: Double
    public var height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

/// Zoom steps of the image viewer (image-zoom.ts: ×1.25 / ×0.8 within 25 %–800 %)
/// and the PDF viewer (±25 % within 50 %–300 %), and the 90° rotation.
public struct ViewerZoom: Sendable {
    public let minimum: Double
    public let maximum: Double
    private let multiplicative: Bool

    public static let image = ViewerZoom(minimum: 0.25, maximum: 8, multiplicative: true)
    public static let pdf = ViewerZoom(minimum: 0.5, maximum: 3, multiplicative: false)

    public func zoomIn(_ zoom: Double) -> Double { clamp(multiplicative ? zoom * 1.25 : zoom + 0.25) }
    public func zoomOut(_ zoom: Double) -> Double { clamp(multiplicative ? zoom * 0.8 : zoom - 0.25) }
    public func canZoomIn(_ zoom: Double) -> Bool { zoom < maximum - 1e-9 }
    public func canZoomOut(_ zoom: Double) -> Bool { zoom > minimum + 1e-9 }
    public func clamp(_ zoom: Double) -> Double { min(maximum, max(minimum, zoom)) }

    public static func percent(_ zoom: Double) -> String { "\(Int((zoom * 100).rounded()))%" }
    public static func rotated(_ degrees: Int) -> Int { (degrees + 90) % 360 }

    /// Scale that fits the image in the viewport without enlarging it.
    public static func fitScale(width: Double, height: Double, into box: CGSizeValue) -> Double {
        guard width > 0, height > 0 else { return 1 }
        return min(1, box.width / width, box.height / height)
    }
}
