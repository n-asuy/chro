import Foundation

/// Text helpers for diffs: git's notion of lines and which renderer a path gets.
public enum DiffText {
    /// Lines as git counts them: a trailing newline terminates the last line.
    public static func lines(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        var lines = text.components(separatedBy: "\n")
        if text.hasSuffix("\n") { lines.removeLast() }
        return lines
    }

    private static let proseExtensions: Set<String> = ["md", "mdx", "markdown", "txt"]
    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico", "tiff", "tif"]

    public static func pathExtension(_ path: String) -> String {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return "" }
        return name[name.index(after: dot)...].lowercased()
    }

    /// Documents (markdown, text) render as a whole document, not a patch.
    public static func isProse(_ path: String) -> Bool { proseExtensions.contains(pathExtension(path)) }
    public static func isImage(_ path: String) -> Bool { imageExtensions.contains(pathExtension(path)) }
}

/// A unified diff's hunks with three lines of context, built from whole old
/// and new contents (the server sends contents, not patches).
public enum DiffHunks {
    public struct Line: Equatable, Sendable {
        public enum Kind: Equatable, Sendable { case context, added, removed }
        public var kind: Kind
        public var oldNumber: Int?
        public var newNumber: Int?
        public var text: String

        public init(kind: Kind, oldNumber: Int?, newNumber: Int?, text: String) {
            self.kind = kind
            self.oldNumber = oldNumber
            self.newNumber = newNumber
            self.text = text
        }
    }

    public struct Hunk: Equatable, Sendable, Identifiable {
        public var header: String
        public var lines: [Line]
        public var id: String { header }
    }

    public static let context = 3

    /// Every line of both sides in order, deletions kept where they were (the document diff of prose files).
    public static func document(old: String, new: String) -> [Line] {
        let oldLines = DiffText.lines(old), newLines = DiffText.lines(new)
        return LineDiff.compute(old: oldLines, new: newLines).map { operation in
            switch operation {
            case .context(let o, let n): return Line(kind: .context, oldNumber: o, newNumber: n, text: newLines[n - 1])
            case .added(let n): return Line(kind: .added, oldNumber: nil, newNumber: n, text: newLines[n - 1])
            case .removed(let o): return Line(kind: .removed, oldNumber: o, newNumber: nil, text: oldLines[o - 1])
            }
        }
    }

    public static func stats(old: String, new: String) -> LineDiff.Stats {
        LineDiff.stats(old: DiffText.lines(old), new: DiffText.lines(new))
    }

    public static func build(old: String, new: String) -> [Hunk] {
        let all = document(old: old, new: new)
        let changed = all.indices.filter { all[$0].kind != .context }
        guard !changed.isEmpty else { return [] }
        // Group changes whose context windows touch or overlap.
        var ranges: [ClosedRange<Int>] = []
        for index in changed {
            let low = max(0, index - context), high = min(all.count - 1, index + context)
            if let last = ranges.last, low <= last.upperBound + 1 {
                ranges[ranges.count - 1] = last.lowerBound...max(last.upperBound, high)
            } else {
                ranges.append(low...high)
            }
        }
        return ranges.map { range in
            let lines = Array(all[range])
            let oldCount = lines.filter { $0.kind != .added }.count
            let newCount = lines.filter { $0.kind != .removed }.count
            let oldStart = oldCount == 0 ? previousNumber(all, before: range.lowerBound, \.oldNumber) : lines.compactMap(\.oldNumber).first!
            let newStart = newCount == 0 ? previousNumber(all, before: range.lowerBound, \.newNumber) : lines.compactMap(\.newNumber).first!
            return Hunk(header: "@@ -\(oldStart),\(oldCount) +\(newStart),\(newCount) @@", lines: lines)
        }
    }

    /// git writes an empty side's start as the line before it (0 at the top).
    private static func previousNumber(_ lines: [Line], before index: Int, _ side: KeyPath<Line, Int?>) -> Int {
        lines[..<index].reversed().compactMap { $0[keyPath: side] }.first ?? 0
    }
}
