import Foundation

/// A frontmatter property value as the property editor types it
/// (frontmatter.ts `getFrontmatterValueType`, the mock's `parseFrontmatter`).
public enum FrontmatterValue: Equatable, Sendable {
    case text(String)
    case number(Double)
    case checkbox(Bool)
    /// `YYYY-MM-DD`.
    case date(String)
    case tags([String])
    /// A map or a list of maps the editor shows but does not edit; the source lines, dedented.
    case nested(String)

    public enum Kind: String, CaseIterable, Sendable {
        case text, number, checkbox, date, tags

        /// The type menu's label.
        public var label: String {
            switch self {
            case .text: "Text"
            case .number: "Number"
            case .checkbox: "Checkbox"
            case .date: "Date"
            case .tags: "Tags"
            }
        }
    }

    /// The editable type; nested values read as text.
    public var type: Kind {
        switch self {
        case .text, .nested: .text
        case .number: .number
        case .checkbox: .checkbox
        case .date: .date
        case .tags: .tags
        }
    }

    /// The value's display string (`Number` without a trailing `.0`).
    public var display: String {
        switch self {
        case .text(let text), .date(let text), .nested(let text): text
        case .number(let number): Self.format(number)
        case .checkbox(let on): on ? "true" : "false"
        case .tags(let tags): tags.joined(separator: ", ")
        }
    }

    /// The type menu's conversion (frontmatter-editor.tsx).
    public func converted(to kind: Kind, today: String) -> FrontmatterValue {
        switch kind {
        case .text:
            return .text(display)
        case .number:
            if case .number = self { return self }
            return .number(Double(display.trimmingCharacters(in: .whitespaces)) ?? 0)
        case .checkbox:
            if case .checkbox = self { return self }
            let text = display
            return .checkbox(!text.isEmpty && text != "false")
        case .date:
            let text = display
            return .date(Frontmatter.isDate(text) ? text : today)
        case .tags:
            if case .tags = self { return self }
            let text = display
            return .tags(text.isEmpty ? [] : [text])
        }
    }

    static func format(_ number: Double) -> String {
        number.rounded() == number && abs(number) < 1e15 ? String(Int64(number)) : String(number)
    }
}

public struct FrontmatterProperty: Equatable, Sendable {
    public var key: String
    public var value: FrontmatterValue
    /// Tags written as `[a, b]` rather than a block list; kept when rewriting.
    public var flowList: Bool
    /// The source lines, so an untouched property rewrites byte for byte.
    var source: [String]?
    var sourceValue: FrontmatterValue?

    public init(key: String, value: FrontmatterValue, flowList: Bool = true) {
        self.key = key
        self.value = value
        self.flowList = flowList
    }
}

/// YAML frontmatter at the top of a note, parsed line by line for the flat
/// shapes the property editor handles. Lines it cannot type are kept verbatim.
public enum Frontmatter {
    public struct Document: Equatable, Sendable {
        public var properties: [FrontmatterProperty]
        /// Index of the first body line (after the closing `---`); 0 without a block.
        public var bodyStart: Int
        public var hasBlock: Bool { bodyStart > 0 }
    }

    public static func parse(_ lines: [String]) -> Document {
        guard lines.first == "---", let close = lines.dropFirst().firstIndex(where: { $0 == "---" || $0 == "..." }) else {
            return Document(properties: [], bodyStart: 0)
        }
        var properties: [FrontmatterProperty] = []
        var index = 1
        while index < close {
            let line = lines[index]
            guard let colon = keyColon(in: line) else { index += 1; continue }
            let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
            let rest = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            var children: [String] = []
            var next = index + 1
            while next < close, lines[next].hasPrefix(" ") || lines[next].hasPrefix("\t") || lines[next].hasPrefix("-") {
                children.append(lines[next])
                next += 1
            }
            var property: FrontmatterProperty
            if rest.isEmpty, !children.isEmpty {
                let items = children.map { $0.trimmingCharacters(in: .whitespaces) }
                if items.allSatisfy({ $0.hasPrefix("- ") && keyColon(in: String($0.dropFirst(2))) == nil }) {
                    property = FrontmatterProperty(key: key, value: .tags(items.map { unquote(String($0.dropFirst(2)).trimmingCharacters(in: .whitespaces)) }), flowList: false)
                } else {
                    property = FrontmatterProperty(key: key, value: .nested(dedent(children)))
                }
            } else {
                property = FrontmatterProperty(key: key, value: scalar(rest))
            }
            property.source = Array(lines[index..<next])
            property.sourceValue = property.value
            properties.append(property)
            index = next
        }
        return Document(properties: properties, bodyStart: close + 1)
    }

    /// The note with its frontmatter replaced by `properties` (no block when empty).
    public static func write(_ properties: [FrontmatterProperty], into lines: [String]) -> [String] {
        let document = parse(lines)
        let body = Array(lines[document.bodyStart...])
        guard !properties.isEmpty else { return body }
        var block = ["---"]
        for property in properties {
            if let source = property.source, property.sourceValue == property.value {
                block += source
            } else {
                block += serialize(property)
            }
        }
        block.append("---")
        return block + body
    }

    public static func isDate(_ text: String) -> Bool {
        text.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
    }

    private static func serialize(_ property: FrontmatterProperty) -> [String] {
        let key = property.key
        switch property.value {
        case .text(let text): return ["\(key): \(quoteIfNeeded(text))"]
        case .number(let number): return ["\(key): \(FrontmatterValue.format(number))"]
        case .checkbox(let on): return ["\(key): \(on)"]
        case .date(let date): return ["\(key): \(date)"]
        case .tags(let tags):
            if property.flowList || tags.isEmpty { return ["\(key): [\(tags.map(quoteIfNeeded).joined(separator: ", "))]"] }
            return ["\(key):"] + tags.map { "  - \(quoteIfNeeded($0))" }
        case .nested(let raw): return ["\(key):"] + raw.components(separatedBy: "\n").map { "  " + $0 }
        }
    }

    /// The `key:` colon of a mapping line (not one inside a value or a URL).
    private static func keyColon(in line: String) -> String.Index? {
        guard let first = line.first, first != " ", first != "\t", first != "-", first != "#" else { return nil }
        guard let colon = line.firstIndex(of: ":") else { return nil }
        let after = line.index(after: colon)
        return after == line.endIndex || line[after] == " " ? colon : nil
    }

    private static func scalar(_ raw: String) -> FrontmatterValue {
        if raw == "true" || raw == "false" { return .checkbox(raw == "true") }
        if raw.hasPrefix("["), raw.hasSuffix("]") {
            let inner = raw.dropFirst().dropLast()
            return .tags(inner.split(separator: ",").map { unquote($0.trimmingCharacters(in: .whitespaces)) }.filter { !$0.isEmpty })
        }
        if raw.range(of: #"^-?\d+(\.\d+)?$"#, options: .regularExpression) != nil, let number = Double(raw) { return .number(number) }
        if isDate(raw) { return .date(raw) }
        return .text(unquote(raw))
    }

    private static func unquote(_ text: String) -> String {
        guard text.count >= 2, let first = text.first, first == text.last, first == "\"" || first == "'" else { return text }
        let inner = String(text.dropFirst().dropLast())
        return first == "\"" ? inner.replacingOccurrences(of: "\\\"", with: "\"") : inner.replacingOccurrences(of: "''", with: "'")
    }

    private static func quoteIfNeeded(_ text: String) -> String {
        if text.isEmpty { return "" }
        let typed = scalar(text)
        let reserved = text.contains(": ") || text.hasPrefix(" ") || text.hasSuffix(" ") || text.contains(" #")
            || "[]{}&*!|>'\"%@`#,-?".contains(text.first!) || ["null", "~", "yes", "no"].contains(text.lowercased())
        guard reserved || typed != .text(text) else { return text }
        return "\"" + text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    private static func dedent(_ lines: [String]) -> String {
        let indent = lines.map { $0.prefix { $0 == " " }.count }.min() ?? 0
        return lines.map { String($0.dropFirst(indent)) }.joined(separator: "\n")
    }
}
