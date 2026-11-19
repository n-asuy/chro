import Foundation

/// A pill above a prompt's text: what the composer attached to it.
public enum PromptAttachment: Equatable, Sendable, Hashable {
    case file(path: String, isDirectory: Bool)
    case session(taskID: String)
    case skill(name: String)
    case image(name: String, path: String)
    /// Page annotations on a document: the user message shows them as one card.
    case annotations(path: String, noteCount: Int)

    /// The pill's text. A session pill shows the referenced session's title when the caller knows it.
    public var label: String {
        switch self {
        case .file(let path, _): return Self.basename(path)
        case .session(let taskID): return String(taskID.prefix(8))
        case .skill(let name): return name
        case .image(let name, _): return name
        case .annotations(let path, let count): return "\(count) notes on \(Self.basename(path))"
        }
    }

    static func basename(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}

/// A prompt split into its pills and its text.
public struct PromptContent: Equatable, Sendable {
    public var attachments: [PromptAttachment]
    public var text: String

    /// A context reference to send with a prompt.
    public struct Reference: Equatable, Sendable {
        public enum Kind: Sendable { case file, directory, session, skill }
        public var kind: Kind
        /// The path, the session's task id or the skill's id.
        public var path: String

        public init(kind: Kind, path: String) {
            self.kind = kind
            self.path = path
        }
    }

    /// An uploaded image the prompt links to.
    public struct Image: Equatable, Sendable {
        public var name: String
        public var path: String

        public init(name: String, path: String) {
            self.name = name
            self.path = path
        }
    }

    // MARK: Parsing (parseContextFromContent)

    private static func regex(_ pattern: String) -> NSRegularExpression { try! NSRegularExpression(pattern: pattern) }
    private static let contextBlock = regex(#"^<context>\n([\s\S]*?)\n</context>"#)
    private static let skillsBlock = regex(#"^<skills_context>\n([\s\S]*?)\n</skills_context>"#)
    private static let fileTag = regex(#"<(file|directory)\s+path="([^"]*?)"(?:\s+branch="([^"]*?)")?\s*/>"#)
    private static let sessionTag = regex(#"<past_session\s+task_id="([^"]*?)"(?:\s+branch="([^"]*?)")?\s*>([\s\S]*?)</past_session>"#)
    private static let annotationsTag = regex(#"<page_annotations\s+path="([^"]*?)"(?:\s+viewport="(\d+)x(\d+)")?\s*>([\s\S]*?)</page_annotations>"#)
    private static let annotationTag = regex(#"<annotation\s+n="\d+"\s+selector="([^"]*?)"\s+rect="(-?\d+),(-?\d+),(\d+),(\d+)"\s*>([\s\S]*?)</annotation>"#)
    private static let commentTag = regex(#"<comment>([\s\S]*?)</comment>"#)
    private static let skillTag = regex(#"<skill\s+id="([^"]*?)"\s+name="([^"]*?)"\s*/>"#)
    private static let imageMarkdown = regex(#"!\[([^\]]*)\]\(([^)]+)\)"#)

    public static func parse(_ content: String) -> PromptContent {
        var context: [PromptAttachment] = []
        var skills: [PromptAttachment] = []
        var remaining = content
        while true {
            if let (inner, rest) = leadingBlock(contextBlock, in: remaining) {
                context += contextEntries(inner)
                remaining = rest
            } else if let (inner, rest) = leadingBlock(skillsBlock, in: remaining) {
                skills += matches(skillTag, in: inner).map { .skill(name: unescape($0[2] ?? "")) }
                remaining = rest
            } else {
                break
            }
        }
        var images: [PromptAttachment] = []
        let ns = remaining as NSString
        var text = ""
        var cursor = 0
        for match in imageMarkdown.matches(in: remaining, range: NSRange(location: 0, length: ns.length)) {
            text += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            images.append(.image(name: ns.substring(with: match.range(at: 1)), path: ns.substring(with: match.range(at: 2))))
            cursor = match.range.location + match.range.length
        }
        text += ns.substring(from: cursor)
        while text.hasPrefix("\n") { text.removeFirst() }
        while text.hasSuffix("\n") { text.removeLast() }
        return PromptContent(attachments: context + skills + images, text: text)
    }

    private static func leadingBlock(_ pattern: NSRegularExpression, in text: String) -> (String, String)? {
        let ns = text as NSString
        guard let match = pattern.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        var rest = ns.substring(from: match.range.location + match.range.length)
        while rest.hasPrefix("\n") { rest.removeFirst() }
        return (ns.substring(with: match.range(at: 1)), rest)
    }

    private static func contextEntries(_ inner: String) -> [PromptAttachment] {
        var indexed: [(Int, PromptAttachment)] = []
        for match in rawMatches(fileTag, in: inner) {
            indexed.append((match.offset, .file(path: unescape(match.groups[2] ?? ""), isDirectory: match.groups[1] == "directory")))
        }
        for match in rawMatches(sessionTag, in: inner) {
            indexed.append((match.offset, .session(taskID: unescape(match.groups[1] ?? ""))))
        }
        for match in rawMatches(annotationsTag, in: inner) {
            let notes = matches(annotationTag, in: match.groups[4] ?? "").filter { body in
                commentTag.firstMatch(in: body[6] ?? "", range: NSRange(location: 0, length: ((body[6] ?? "") as NSString).length)) != nil
            }
            indexed.append((match.offset, .annotations(path: unescape(match.groups[1] ?? ""), noteCount: notes.count)))
        }
        return indexed.sorted { $0.0 < $1.0 }.map(\.1)
    }

    private struct RawMatch {
        var offset: Int
        var groups: [String?]
    }

    private static func rawMatches(_ pattern: NSRegularExpression, in text: String) -> [RawMatch] {
        let ns = text as NSString
        return pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
            RawMatch(offset: match.range.location, groups: (0..<match.numberOfRanges).map { index in
                let range = match.range(at: index)
                return range.location == NSNotFound ? nil : ns.substring(with: range)
            })
        }
    }

    private static func matches(_ pattern: NSRegularExpression, in text: String) -> [[String?]] {
        rawMatches(pattern, in: text).map(\.groups)
    }

    // MARK: Formatting (the desktop's buildPromptPayload)

    private static let sessionNote = "Referenced session. A summary is injected at execution time; run `chro session read %@ --format markdown` for the full transcript."

    /// `[context block, skills block, image markdown, text].filter(Boolean).join("\n").trim()`
    public static func format(text: String, references: [Reference], images: [Image]) -> String {
        let context = references.compactMap { reference -> String? in
            switch reference.kind {
            case .file: return "<file path=\"\(escape(reference.path))\" />"
            case .directory: return "<directory path=\"\(escape(reference.path))\" />"
            case .session:
                return ["<past_session task_id=\"\(escape(reference.path))\">",
                        String(format: sessionNote, reference.path),
                        "</past_session>"].joined(separator: "\n")
            case .skill: return nil
            }
        }
        let skills = references.filter { $0.kind == .skill }.map { "<skill id=\"\(escape($0.path))\" name=\"\(escape($0.path))\" />" }
        let parts = [
            context.isEmpty ? "" : "<context>\n\(context.joined(separator: "\n"))\n</context>",
            skills.isEmpty ? "" : "<skills_context>\n\(skills.joined(separator: "\n"))\n</skills_context>",
            images.map { "![\($0.name)](\($0.path))" }.joined(separator: "\n"),
            text.trimmingCharacters(in: .whitespacesAndNewlines),
        ]
        return parts.filter { !$0.isEmpty }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func escape(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }

    static func unescape(_ value: String) -> String {
        value.replacingOccurrences(of: "&gt;", with: ">").replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&amp;", with: "&")
    }
}
