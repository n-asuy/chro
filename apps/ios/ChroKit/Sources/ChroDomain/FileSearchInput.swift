import Foundation

/// Content-search ordering (`sort` of `/rpc/projects/:project_id/search`).
public enum FileSearchSort: String, CaseIterable, Sendable {
    case relevance
    case modifiedDescending = "modified-desc"
    case modifiedAscending = "modified-asc"
    case nameAscending = "name-asc"
    case nameDescending = "name-desc"
    case pathAscending = "path-asc"
    case pathDescending = "path-desc"

    public var label: String {
        switch self {
        case .relevance: return "Relevance"
        case .modifiedDescending: return "Modified (new to old)"
        case .modifiedAscending: return "Modified (old to new)"
        case .nameAscending: return "File name (A to Z)"
        case .nameDescending: return "File name (Z to A)"
        case .pathAscending: return "Path (A to Z)"
        case .pathDescending: return "Path (Z to A)"
        }
    }
}

/// The Search panel's input rules (search-panel.tsx): the operator list,
/// `path:`/`file:` completion, history, and name highlighting.
public enum FileSearchInput {
    public struct Option: Equatable, Sendable {
        public var token: String
        public var description: String
        /// Inserted when the row is tapped; nil rows only explain.
        public var insert: String?
    }

    public static let options: [Option] = [
        Option(token: "path:", description: "match file path", insert: "path:"),
        Option(token: "file:", description: "match file name", insert: "file:"),
        Option(token: "content:", description: "match file content", insert: "content:"),
        Option(token: "tag:", description: "match #tag", insert: "tag:"),
        Option(token: "line:(…)", description: "keywords on the same line", insert: nil),
        Option(token: "match-case:", description: "case-sensitive", insert: "match-case:"),
        Option(token: "\"…\"", description: "exact phrase", insert: nil),
        Option(token: "/…/", description: "regular expression", insert: nil),
        Option(token: "a OR b   -c", description: "logic: OR, exclude", insert: nil),
    ]

    public static let historyLimit = 10
    public static let suggestionLimit = 20
    /// Content results asked for per search.
    public static let resultLimit = 50

    public enum Field: String, Sendable { case path, file }

    /// An incomplete `path:`/`file:` at the end of the query.
    public struct TrailingOperator: Equatable, Sendable {
        public var field: Field
        public var partial: String
        /// Character offset where `field:` starts.
        public var start: Int

        public init(field: Field, partial: String, start: Int) {
            self.field = field
            self.partial = partial
            self.start = start
        }
    }

    public static func trailingOperator(_ query: String) -> TrailingOperator? {
        let pattern = /(^|[\s(])(path|file):([^\s"()]*)$/
        guard let match = query.firstMatch(of: pattern) else { return nil }
        let start = query.distance(from: query.startIndex, to: match.output.0.startIndex) + match.output.1.count
        return TrailingOperator(field: match.output.2 == "path" ? .path : .file, partial: String(match.output.3), start: start)
    }

    /// The query with the trailing operator's partial replaced by `value`.
    public static func complete(_ query: String, operator active: TrailingOperator, with value: String) -> String {
        String(query.prefix(active.start)) + "\(active.field.rawValue):\(value)"
    }

    /// An option row's token appended, separated by a space when needed.
    public static func insert(_ token: String, into query: String) -> String {
        !query.isEmpty && !query.hasSuffix(" ") ? "\(query) \(token)" : query + token
    }

    /// Completions for `path:` (paths and matching ancestor folders) or `file:` (file names).
    public static func suggestions(_ field: Field, partial: String, from hits: [(path: String, isFile: Bool)]) -> [String] {
        let needle = partial.lowercased()
        var found = Set<String>()
        for hit in hits {
            let path = String(hit.path.drop { $0 == "/" })
            if field == .file {
                guard hit.isFile else { continue }
                let base = path.split(separator: "/").last.map(String.init) ?? path
                if base.lowercased().contains(needle) { found.insert(base) }
                continue
            }
            if path.lowercased().contains(needle) { found.insert(path) }
            let segments = path.split(separator: "/")
            for index in segments.indices.dropFirst() {
                let directory = segments[..<index].joined(separator: "/")
                if directory.lowercased().contains(needle) { found.insert(directory) }
            }
        }
        return found.sorted { $0.count != $1.count ? $0.count < $1.count : $0.localizedCompare($1) == .orderedAscending }
            .prefix(suggestionLimit).map { $0 }
    }

    /// Most recent first, de-duplicated, capped (lib/search-history.ts).
    public static func pushHistory(_ query: String, onto history: [String]) -> [String] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return history }
        return Array(([trimmed] + history.filter { $0 != trimmed }).prefix(historyLimit))
    }

    private static let knownFields: Set<String> = ["file", "path", "content", "tag", "line", "section", "block", "task",
                                                    "task-todo", "task-done", "match-case", "ignore-case"]

    /// Plain words of a query, lowercased, for highlighting name-only results.
    public static func plainNeedles(_ query: String) -> [String] {
        var needles: [String] = []
        for match in query.matches(of: /"([^"]+)"/) { needles.append(String(match.output.1)) }
        let rest = query.replacing(/"[^"]*"/, with: " ").replacing(/\/[^\/]*\//, with: " ")
        for raw in rest.split(whereSeparator: \.isWhitespace) {
            var token = String(raw)
            if token == "OR" || token.hasPrefix("-") { continue }
            token = String(token.drop { $0 == "(" })
            while token.hasSuffix(")") { token.removeLast() }
            if let colon = token.firstIndex(of: ":"), knownFields.contains(String(token[..<colon])) {
                token = String(token[token.index(after: colon)...])
                if token.hasPrefix("#") { token.removeFirst() }
            }
            if !token.isEmpty { needles.append(token) }
        }
        return needles.map { $0.lowercased() }.filter { !$0.isEmpty }
    }

    /// Case-insensitive occurrences of the needles in `text`, merged (UTF-16 offsets).
    public static func needleRanges(in text: String, needles: [String]) -> [Range<Int>] {
        let haystack = text.lowercased() as NSString
        guard !needles.isEmpty, haystack.length == (text as NSString).length else { return [] }
        var ranges: [Range<Int>] = []
        for needle in needles where !needle.isEmpty {
            var from = 0
            while from < haystack.length {
                let hit = haystack.range(of: needle, options: .literal, range: NSRange(location: from, length: haystack.length - from))
                if hit.location == NSNotFound { break }
                ranges.append(hit.location..<(hit.location + hit.length))
                from = hit.location + hit.length
            }
        }
        return merge(ranges)
    }

    /// `3 files · 9 matches`, with `+` and `· top N` when the server capped the set.
    public static func summary(files: Int, matches: Int, shown: Int, truncated: Bool) -> String {
        "\(files)\(truncated ? "+" : "") \(files == 1 ? "file" : "files") · \(matches) \(matches == 1 ? "match" : "matches")\(truncated ? " · top \(shown)" : "")"
    }

    static func merge(_ ranges: [Range<Int>]) -> [Range<Int>] {
        var merged: [Range<Int>] = []
        for range in ranges.sorted(by: { $0.lowerBound < $1.lowerBound }) {
            if let last = merged.last, range.lowerBound <= last.upperBound {
                merged[merged.count - 1] = last.lowerBound..<max(last.upperBound, range.upperBound)
            } else {
                merged.append(range)
            }
        }
        return merged
    }
}

/// The line a content match shows (file-search-cache `build_snippet`): leading
/// whitespace trimmed, and lines over 240 bytes windowed around the first match
/// with `…` on the cut sides. Offsets are UTF-16.
public struct FileSearchSnippet: Equatable, Sendable {
    public var text: String
    public var ranges: [Range<Int>]

    static let maxLength = 240
    static let leadLength = 32

    public static func make(line: String, ranges: [Range<Int>]) -> FileSearchSnippet {
        let units = Array(line.utf16)
        var end = units.count
        while end > 0, units[end - 1] == 10 || units[end - 1] == 13 { end -= 1 }
        var leading = 0
        while leading < end, units[leading] == 32 || units[leading] == 9 { leading += 1 }
        let trimmed = Array(units[leading..<end])
        let shifted = FileSearchInput.merge(ranges).compactMap { range -> Range<Int>? in
            let lower = max(0, range.lowerBound - leading), upper = max(0, range.upperBound - leading)
            return upper > lower ? lower..<upper : nil
        }
        var windowStart = 0, windowEnd = trimmed.count
        if trimmed.count > maxLength {
            windowStart = max(0, (shifted.first?.lowerBound ?? 0) - leadLength)
            windowEnd = min(trimmed.count, windowStart + maxLength)
        }
        let lead = windowStart > 0 ? "…" : "", trail = windowEnd < trimmed.count ? "…" : ""
        let window = String(decoding: trimmed[windowStart..<windowEnd], as: UTF16.self)
        let offset = lead.utf16.count
        let clipped = shifted.compactMap { range -> Range<Int>? in
            let lower = max(range.lowerBound, windowStart), upper = min(range.upperBound, windowEnd)
            return upper > lower ? (lower - windowStart + offset)..<(upper - windowStart + offset) : nil
        }
        return FileSearchSnippet(text: lead + window + trail, ranges: clipped)
    }
}
