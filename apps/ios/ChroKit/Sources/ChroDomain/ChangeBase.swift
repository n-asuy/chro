import Foundation

/// What an open file's change markers compare against (use-change-base.ts):
/// the base version from the diff of its scope (uncommitted changes in a
/// project, the session's changes in a worktree).
public enum ChangeBase: Equatable, Sendable {
    /// The diff has not loaded yet: no markers rather than wrong ones.
    case unknown
    /// Not in the diff: the file on disk is its own base.
    case unchanged
    case changed(base: String)
    /// In the diff without comparable text (binary, omitted).
    case unavailable

    /// One file of the scope's diff.
    public struct Entry: Equatable, Sendable {
        public var path: String
        public var oldContent: String?
        /// False for binary files and contents the server left out.
        public var isComparable: Bool

        public init(path: String, oldContent: String?, isComparable: Bool) {
            self.path = path
            self.oldContent = oldContent
            self.isComparable = isComparable
        }
    }

    /// `entries` nil while the diff is still loading.
    public static func resolve(path: String, entries: [Entry]?) -> ChangeBase {
        let target = stripped(path)
        guard let entries else { return .unknown }
        guard let entry = entries.first(where: { stripped($0.path) == target }) else { return .unchanged }
        return entry.isComparable ? .changed(base: entry.oldContent ?? "") : .unavailable
    }

    /// The text to mark changes against, given the file as last read from disk.
    public func text(disk: String?) -> String? {
        switch self {
        case .changed(let base): base
        case .unchanged: disk
        case .unknown, .unavailable: nil
        }
    }

    /// 1-based lines of `text` added or edited against `base` (the gutter's green bar).
    public static func changedLines(base: String?, text: String) -> Set<Int> {
        guard let base else { return [] }
        return LineDiff.changedNewLines(old: fileLines(base), new: fileLines(text))
    }

    /// Lines as git counts them: a final newline ends the last line rather than starting another.
    private static func fileLines(_ text: String) -> [String] {
        var lines = LineDiff.lines(text)
        if text.hasSuffix("\n") { lines.removeLast() }
        return lines
    }

    private static func stripped(_ path: String) -> String {
        String(path.drop { $0 == "/" })
    }
}
