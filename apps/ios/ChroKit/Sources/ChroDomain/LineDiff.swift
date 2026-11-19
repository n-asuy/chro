import Foundation

/// A line diff over the longest common subsequence, as the mock's generic
/// diff renderer computes it (`lineDiff`). The server sends whole old and new
/// contents per file (log-types `Diff`); the phone derives lines from them.
public enum LineDiff {
    public enum Operation: Equatable, Sendable {
        /// 1-based line numbers on each side.
        case context(old: Int, new: Int)
        case added(new: Int)
        case removed(old: Int)
    }

    public struct Stats: Equatable, Sendable {
        public var additions: Int
        public var deletions: Int
    }

    public static func compute(old: [String], new: [String]) -> [Operation] {
        let n = old.count, m = new.count
        // lengths[i][j]: LCS length of old[i...] and new[j...].
        var lengths = [[Int]](repeating: [Int](repeating: 0, count: m + 1), count: n + 1)
        if n > 0 && m > 0 {
            for i in stride(from: n - 1, through: 0, by: -1) {
                for j in stride(from: m - 1, through: 0, by: -1) {
                    lengths[i][j] = old[i] == new[j] ? lengths[i + 1][j + 1] + 1 : max(lengths[i + 1][j], lengths[i][j + 1])
                }
            }
        }
        var operations: [Operation] = []
        operations.reserveCapacity(n + m)
        var i = 0, j = 0
        while i < n || j < m {
            if i < n && j < m && old[i] == new[j] {
                operations.append(.context(old: i + 1, new: j + 1))
                i += 1
                j += 1
            } else if j < m && (i >= n || lengths[i][j + 1] >= lengths[i + 1][j]) {
                operations.append(.added(new: j + 1))
                j += 1
            } else {
                operations.append(.removed(old: i + 1))
                i += 1
            }
        }
        return operations
    }

    /// New-side line numbers that are added or changed (the editor's change gutter).
    public static func changedNewLines(old: [String], new: [String]) -> Set<Int> {
        Set(compute(old: old, new: new).compactMap { if case .added(let line) = $0 { line } else { nil } })
    }

    public static func stats(old: [String], new: [String]) -> Stats {
        compute(old: old, new: new).reduce(into: Stats(additions: 0, deletions: 0)) { stats, operation in
            switch operation {
            case .added: stats.additions += 1
            case .removed: stats.deletions += 1
            case .context: break
            }
        }
    }

    /// Text as lines; a trailing newline yields a final empty line, empty text no lines.
    public static func lines(_ text: String) -> [String] {
        text.isEmpty ? [] : text.components(separatedBy: "\n")
    }
}
