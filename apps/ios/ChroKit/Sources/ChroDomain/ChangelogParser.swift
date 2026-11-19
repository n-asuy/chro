import Foundation

/// One released version and its bullet notes (system/changelog-parser.ts).
public struct ChangelogRelease: Equatable, Sendable, Identifiable {
    /// The version exactly as the heading writes it, e.g. `0.1.40`.
    public var version: String
    public var notes: [String]
    public var id: String { version }

    public init(version: String, notes: [String]) {
        self.version = version
        self.notes = notes
    }
}

/// A run of note text, inline `code` or plain.
public struct InlineSegment: Equatable, Sendable {
    public var code: Bool
    public var text: String

    public init(code: Bool, text: String) {
        self.code = code
        self.text = text
    }
}

/// Parses the bundled CHANGELOG.md the way the desktop's release notes do.
public enum ChangelogParser {
    /// `## <version>` starts a release; `- ` / `* ` lines are notes; a plain
    /// line after a note continues it. Text before the first release is ignored.
    public static func parse(_ source: String) -> [ChangelogRelease] {
        var releases: [ChangelogRelease] = []
        for rawLine in source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            if let version = heading(rawLine) {
                releases.append(ChangelogRelease(version: version, notes: []))
                continue
            }
            guard !releases.isEmpty else { continue }
            if let note = bullet(rawLine) {
                releases[releases.count - 1].notes.append(note)
                continue
            }
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, let last = releases[releases.count - 1].notes.indices.last else { continue }
            releases[releases.count - 1].notes[last] += " " + line
        }
        return releases
    }

    /// Splits on backtick pairs; an unterminated backtick stays literal.
    public static func splitInlineCode(_ text: String) -> [InlineSegment] {
        var segments: [InlineSegment] = []
        var rest = Substring(text)
        while !rest.isEmpty {
            guard let open = rest.firstIndex(of: "`"),
                  let close = rest[rest.index(after: open)...].firstIndex(of: "`") else {
                segments.append(InlineSegment(code: false, text: String(rest)))
                break
            }
            segments.append(InlineSegment(code: false, text: String(rest[..<open])))
            segments.append(InlineSegment(code: true, text: String(rest[rest.index(after: open)..<close])))
            rest = rest[rest.index(after: close)...]
        }
        return segments.filter { !$0.text.isEmpty }
    }

    /// The heading label: `v` added unless the version already starts with one.
    public static func versionLabel(_ version: String) -> String {
        version.lowercased().hasPrefix("v") ? version : "v" + version
    }

    /// Whether a changelog version is the running build's (system/changelog.ts isCurrentVersion).
    public static func isCurrent(_ version: String, current: String) -> Bool {
        let current = normalize(current)
        return !current.isEmpty && normalize(version) == current
    }

    private static func normalize(_ value: String) -> String {
        var trimmed = value.trimmingCharacters(in: .whitespaces)
        if trimmed.first == "v" || trimmed.first == "V" { trimmed.removeFirst() }
        return trimmed.trimmingCharacters(in: .whitespaces)
    }

    private static func heading(_ line: String) -> String? {
        guard line.hasPrefix("##") else { return nil }
        let rest = line.dropFirst(2)
        guard let first = rest.first, first.isWhitespace else { return nil }
        let version = rest.trimmingCharacters(in: .whitespaces)
        return version.isEmpty ? nil : version
    }

    private static func bullet(_ line: String) -> String? {
        let body = line.drop { $0 == " " || $0 == "\t" }
        guard let marker = body.first, marker == "-" || marker == "*" else { return nil }
        let afterMarker = body.dropFirst()
        guard let space = afterMarker.first, space.isWhitespace else { return nil }
        return afterMarker.trimmingCharacters(in: .whitespaces)
    }
}
