import Foundation

/// The boolean content-search language of the right dock's Search panel, as
/// the server evaluates it (file-search-cache `query.rs`):
///
/// - implicit AND between terms, `OR`, `-` negation, `(` `)` grouping;
/// - `"exact phrase"` and `/regex/`;
/// - fields `file:`, `path:`, `content:` (default), `tag:`;
/// - same-line scoping `line:(a b)` or `line:a`;
/// - `match-case:` / `ignore-case:`, otherwise smart case (sensitive only when
///   the term has an uppercase letter) unless the caller forces a case.
///
/// The phone runs it for the fixture service; a live host evaluates the same
/// grammar itself. Highlight ranges are UTF-16 offsets, as the server sends them.
public struct FileSearchQuery: Sendable {
    /// Highlight ranges per 1-based line number.
    public typealias Highlights = [Int: [Range<Int>]]

    public struct InvalidQuery: Error, Equatable {
        public var message: String
    }

    /// Ranges kept per line (a minified line can match thousands of times).
    static let maxRangesPerLine = 64

    private let root: Node
    /// False when only `file:`/`path:` terms are used: contents need not be read.
    public let readsContent: Bool

    /// - Parameter caseSensitive: nil for smart case, else forced for every term.
    public init(_ input: String, caseSensitive: Bool? = nil) throws {
        var parser = Parser(tokens: Self.tokenize(input), defaultCase: caseSensitive)
        root = try parser.parseOr()
        readsContent = root.readsContent
    }

    /// True for blank input.
    public var isEmpty: Bool { if case .any = root { true } else { false } }

    /// Whether the file at `name` (root-relative path) with `lines` matches;
    /// nil when it does not, else the highlights (possibly empty).
    public func evaluate(name: String, lines: [String]) -> Highlights? {
        root.evaluate(name: name, lines: lines)
    }

    /// Whether the basename alone satisfies the query (relevance ranking only).
    public func matchesName(_ path: String) -> Bool {
        let base = path.split(separator: "/").last.map(String.init) ?? path
        return evaluate(name: path, lines: [base]) != nil
    }

    // MARK: - Tokens

    private enum Token: Equatable {
        case open, close, or, minus
        case word(String)
    }

    private static func tokenize(_ input: String) -> [Token] {
        let chars = Array(input)
        var tokens: [Token] = []
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c.isWhitespace { i += 1; continue }
            if c == "(" { tokens.append(.open); i += 1; continue }
            if c == ")" { tokens.append(.close); i += 1; continue }
            if c == "-" { tokens.append(.minus); i += 1; continue }
            let start = i
            var word = ""
            while i < chars.count {
                let ch = chars[i]
                if ch.isWhitespace || ch == "(" || ch == ")" { break }
                if ch == "\"" {
                    word.append(ch)
                    i += 1
                    while i < chars.count {
                        word.append(chars[i])
                        let closed = chars[i] == "\"" && chars[i - 1] != "\\"
                        i += 1
                        if closed { break }
                    }
                    continue
                }
                if ch == "/" && i == start {
                    word.append(ch)
                    i += 1
                    while i < chars.count {
                        word.append(chars[i])
                        let closed = chars[i] == "/"
                        i += 1
                        if closed { break }
                    }
                    continue
                }
                word.append(ch)
                i += 1
            }
            if word == "OR" {
                tokens.append(.or)
            } else if !word.isEmpty {
                tokens.append(.word(word))
            }
        }
        return tokens
    }

    // MARK: - Parser: or := and ("OR" and)*, and := unary+, unary := "-" unary | atom

    private struct Parser {
        let tokens: [Token]
        var position = 0
        let defaultCase: Bool?

        init(tokens: [Token], defaultCase: Bool?) {
            self.tokens = tokens
            self.defaultCase = defaultCase
        }

        private var peek: Token? { position < tokens.count ? tokens[position] : nil }

        mutating func parseOr() throws -> Node {
            var branches = [try parseAnd()]
            while peek == .or {
                position += 1
                branches.append(try parseAnd())
            }
            return branches.count == 1 ? branches[0] : .or(branches)
        }

        private mutating func parseAnd() throws -> Node {
            var terms: [Node] = []
            while let token = peek, token != .or, token != .close {
                terms.append(try parseUnary())
            }
            switch terms.count {
            case 0: return .any
            case 1: return terms[0]
            default: return .and(terms)
            }
        }

        private mutating func parseUnary() throws -> Node {
            if peek == .minus {
                position += 1
                return .not(try parseUnary())
            }
            return try parseAtom()
        }

        private mutating func parseAtom() throws -> Node {
            switch peek {
            case .open?:
                position += 1
                let inner = try parseOr()
                if peek == .close { position += 1 }
                return inner
            case .word(let word)?:
                position += 1
                return try compile(word)
            default:
                // A stray OR, minus or closing paren: no-op.
                position += 1
                return .any
            }
        }

        private mutating func compile(_ word: String) throws -> Node {
            if let (prefix, rest) = Self.splitField(word) {
                switch prefix {
                case "file": return try leaf(.file, rest, defaultCase)
                case "path": return try leaf(.path, rest, defaultCase)
                case "content": return try leaf(.content, rest, defaultCase)
                case "match-case": return try leaf(.content, rest, true)
                case "ignore-case": return try leaf(.content, rest, false)
                case "tag":
                    let tag = rest.hasPrefix("#") ? String(rest.dropFirst()) : rest
                    return try leaf(.content, "#\(tag)", defaultCase)
                case "line":
                    let inner = rest.isEmpty ? try parseAtom() : try leaf(.content, rest, defaultCase)
                    return .sameLine(inner)
                default: break
                }
            }
            return try leaf(.content, word, defaultCase)
        }

        private func leaf(_ field: Field, _ raw: String, _ caseSensitive: Bool?) throws -> Node {
            let value = raw.trimmingCharacters(in: .whitespaces)
            if value.isEmpty { return .any }
            if value.count >= 2, value.hasPrefix("/"), value.hasSuffix("/") {
                let pattern = String(value.dropFirst().dropLast())
                let insensitive = caseSensitive == false || (caseSensitive == nil && !Self.hasUppercase(pattern))
                do {
                    let regex = try NSRegularExpression(pattern: pattern, options: insensitive ? [.caseInsensitive] : [])
                    return .term(Term(field: field, matcher: .regex(regex)))
                } catch {
                    throw InvalidQuery(message: "invalid regex: \(pattern)")
                }
            }
            var needle = value
            if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") {
                needle = String(value.dropFirst().dropLast()).replacingOccurrences(of: "\\\"", with: "\"")
            }
            let sensitive = caseSensitive ?? Self.hasUppercase(needle)
            return .term(Term(field: field, matcher: .text(needle, caseSensitive: sensitive)))
        }

        /// `field:value` when `field` is lowercase letters and hyphens (so URLs and drive paths stay words).
        private static func splitField(_ word: String) -> (String, String)? {
            guard let colon = word.firstIndex(of: ":") else { return nil }
            let prefix = word[..<colon]
            guard !prefix.isEmpty, prefix.allSatisfy({ ($0.isASCII && $0.isLowercase) || $0 == "-" }) else { return nil }
            return (String(prefix), String(word[word.index(after: colon)...]))
        }

        private static func hasUppercase(_ text: String) -> Bool { text.contains { $0.isUppercase } }
    }

    // MARK: - Evaluation

    private enum Field { case content, file, path }

    private enum Matcher: @unchecked Sendable {
        case text(String, caseSensitive: Bool)
        case regex(NSRegularExpression)

        func matches(_ haystack: String) -> Bool { !ranges(in: haystack, limit: 1).isEmpty }

        func ranges(in line: String, limit: Int) -> [Range<Int>] {
            let text = line as NSString
            switch self {
            case .text(let needle, let caseSensitive):
                guard !needle.isEmpty else { return [] }
                var found: [Range<Int>] = []
                var from = 0
                while found.count < limit, from <= text.length {
                    let hit = text.range(of: needle, options: caseSensitive ? [.literal] : [.literal, .caseInsensitive],
                                         range: NSRange(location: from, length: text.length - from))
                    if hit.location == NSNotFound || hit.length == 0 { break }
                    found.append(hit.location..<(hit.location + hit.length))
                    from = hit.location + hit.length
                }
                return found
            case .regex(let regex):
                return regex.matches(in: line, range: NSRange(location: 0, length: text.length))
                    .lazy.filter { $0.range.length > 0 }.prefix(limit)
                    .map { $0.range.location..<($0.range.location + $0.range.length) }
            }
        }
    }

    private struct Term: Sendable {
        let field: Field
        let matcher: Matcher
    }

    private indirect enum Node: Sendable {
        case and([Node])
        case or([Node])
        case not(Node)
        case term(Term)
        case sameLine(Node)
        case any

        var readsContent: Bool {
            switch self {
            case .term(let term): return term.field == .content
            case .sameLine: return true
            case .not(let inner): return inner.readsContent
            case .and(let nodes), .or(let nodes): return nodes.contains { $0.readsContent }
            case .any: return false
            }
        }

        func evaluate(name: String, lines: [String]) -> Highlights? {
            switch self {
            case .any:
                return [:]
            case .term(let term):
                return Self.evaluate(term, name: name, lines: lines)
            case .not(let inner):
                return inner.evaluate(name: name, lines: lines) == nil ? [:] : nil
            case .and(let nodes):
                var merged: Highlights = [:]
                for node in nodes {
                    guard let highlights = node.evaluate(name: name, lines: lines) else { return nil }
                    Self.merge(highlights, into: &merged)
                }
                return merged
            case .or(let nodes):
                var merged: Highlights = [:]
                var any = false
                for node in nodes {
                    if let highlights = node.evaluate(name: name, lines: lines) {
                        any = true
                        Self.merge(highlights, into: &merged)
                    }
                }
                return any ? merged : nil
            case .sameLine(let inner):
                var merged: Highlights = [:]
                var any = false
                for (index, line) in lines.enumerated() {
                    if let highlights = inner.evaluate(name: name, lines: [line]) {
                        any = true
                        if let ranges = highlights[1] { merged[index + 1] = ranges }
                    }
                }
                return any ? merged : nil
            }
        }

        private static func evaluate(_ term: Term, name: String, lines: [String]) -> Highlights? {
            switch term.field {
            case .file:
                let base = name.split(separator: "/").last.map(String.init) ?? name
                return term.matcher.matches(base) ? [:] : nil
            case .path:
                return term.matcher.matches(name) ? [:] : nil
            case .content:
                var highlights: Highlights = [:]
                for (index, line) in lines.enumerated() {
                    let ranges = term.matcher.ranges(in: line, limit: FileSearchQuery.maxRangesPerLine)
                    if !ranges.isEmpty { highlights[index + 1] = ranges }
                }
                return highlights.isEmpty ? nil : highlights
            }
        }

        private static func merge(_ source: Highlights, into target: inout Highlights) {
            for (line, ranges) in source {
                let existing = target[line] ?? []
                let room = FileSearchQuery.maxRangesPerLine - existing.count
                target[line] = existing + ranges.prefix(max(0, room))
            }
        }
    }
}
