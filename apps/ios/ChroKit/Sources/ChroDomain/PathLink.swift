import Foundation

/// The first tier of turning a path-like string in agent output into a link
/// (session/components/file-path-utils.ts): a free shape test that keeps the
/// obvious non-candidates (`useState`, commands, URLs) from costing a probe.
/// The second tier, the server's probe, decides link-ness; only probed hits
/// are drawn as links, so a link that is shown always opens.
public enum PathLinkShape {
    /// File and folder names with spaces are ordinary; prose is cut off by this cap.
    static let maxSpaces = 3

    public static func looksLikeFilePath(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 512 else { return false }
        if trimmed.contains(where: { "\n\r\t`'\"<>".contains($0) }) { return false }
        if trimmed.filter({ $0 == " " }).count > maxSpaces { return false }
        if trimmed.range(of: #"^[a-z][a-z0-9+.-]*://"#, options: [.regularExpression, .caseInsensitive]) != nil { return false }
        if trimmed.hasPrefix("#") || trimmed == "/" || trimmed == "//" { return false }
        return trimmed.contains("/") || trimmed.range(of: #"\.[A-Za-z0-9]{1,12}(?::\d+(?::\d+)?)?$"#, options: .regularExpression) != nil
    }

    public struct Position: Equatable, Sendable {
        public var path: String
        public var line: Int?
        public var column: Int?

        public init(path: String, line: Int?, column: Int?) {
            self.path = path
            self.line = line
            self.column = column
        }
    }

    /// A trailing `:line[:column]`, as the server splits it: only all-digit
    /// segments, at most two, so `C:/src` and `note:draft` keep their colons.
    public static func splitPosition(_ raw: String) -> Position {
        guard let (head, first) = splitTrailingNumber(raw) else { return Position(path: raw, line: nil, column: nil) }
        if let (path, line) = splitTrailingNumber(head) { return Position(path: path, line: line, column: first) }
        return Position(path: head, line: first, column: nil)
    }

    private static func splitTrailingNumber(_ raw: String) -> (String, Int)? {
        guard let colon = raw.lastIndex(of: ":") else { return nil }
        let head = String(raw[..<colon]), tail = String(raw[raw.index(after: colon)...])
        guard !head.isEmpty, !tail.isEmpty, tail.allSatisfy(\.isASCIIDigit), let number = Int(tail) else { return nil }
        return (head, number)
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}

/// One answer of `POST …/probe-paths` (routes/rpc/path_link.rs), index-aligned with the request.
public struct PathProbeResult: Equatable, Sendable {
    public enum Kind: String, Sendable { case file, directory }

    public var exists: Bool
    public var kind: Kind?
    public var absolutePath: String?
    /// The workspace root the path lives under; absent outside every root.
    public var root: String?
    public var relativePath: String?
    public var line: Int?
    public var column: Int?

    public init(exists: Bool, kind: Kind? = nil, absolutePath: String? = nil, root: String? = nil,
                relativePath: String? = nil, line: Int? = nil, column: Int? = nil) {
        self.exists = exists
        self.kind = kind
        self.absolutePath = absolutePath
        self.root = root
        self.relativePath = relativePath
        self.line = line
        self.column = column
    }

    public struct Relative: Equatable, Sendable {
        public var rootIndex: Int
        public var path: String

        public init(rootIndex: Int, path: String) {
            self.rootIndex = rootIndex
            self.path = path
        }
    }

    /// Which of the phone's checkout roots holds the hit, and the path inside
    /// it. Nil for misses and for paths outside every root (another project,
    /// the home folder): the phone can open only the checkouts it browses.
    public func relative(toAnyOf roots: [String]) -> Relative? {
        guard exists, let absolutePath else { return nil }
        for (index, root) in roots.enumerated() {
            let base = root.hasSuffix("/") ? String(root.dropLast()) : root
            guard !base.isEmpty else { continue }
            if absolutePath == base { return Relative(rootIndex: index, path: "") }
            if absolutePath.hasPrefix(base + "/") { return Relative(rootIndex: index, path: String(absolutePath.dropFirst(base.count + 1))) }
        }
        return nil
    }
}
