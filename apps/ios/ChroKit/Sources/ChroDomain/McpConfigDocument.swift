import ChroAPI
import Foundation

/// A JSON document as the MCP editor shows it (the API's `JSONValue`). Objects
/// print with sorted keys, as the server's maps serialize them.
extension JSONValue {
    public struct SyntaxError: Error, Equatable {}

    public static func parse(_ text: String) throws -> JSONValue {
        guard let data = text.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { throw SyntaxError() }
        return JSONValue(any)
    }

    public init(_ any: Any) {
        switch any {
        case let dictionary as [String: Any]: self = .object(dictionary.mapValues(JSONValue.init))
        case let array as [Any]: self = .array(array.map(JSONValue.init))
        case let string as String: self = .string(string)
        case let number as NSNumber:
            self = CFGetTypeID(number) == CFBooleanGetTypeID() ? .bool(number.boolValue) : .number(number.doubleValue)
        default: self = .null
        }
    }

    /// `JSON.stringify(value, null, 2)`.
    public func prettyPrinted(indent: String = "") -> String {
        let inner = indent + "  "
        switch self {
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .number(let value):
            if value.rounded() == value, abs(value) < 1e15 { return String(Int64(value)) }
            return String(value)
        case .string(let value): return JSONValue.quote(value)
        case .array(let items):
            guard !items.isEmpty else { return "[]" }
            return "[\n" + items.map { inner + $0.prettyPrinted(indent: inner) }.joined(separator: ",\n") + "\n" + indent + "]"
        case .object(let members):
            guard !members.isEmpty else { return "{}" }
            return "{\n" + members.keys.sorted().map { key in
                inner + JSONValue.quote(key) + ": " + members[key]!.prettyPrinted(indent: inner)
            }.joined(separator: ",\n") + "\n" + indent + "}"
        }
    }

    var objectMembers: [String: JSONValue]? { if case .object(let members) = self { members } else { nil } }

    private static func quote(_ string: String) -> String {
        var out = "\""
        for scalar in string.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

/// Where an agent's config file keeps its MCP servers (mcp-strategy.ts
/// `McpConfig`: `servers_path` and the `template` the servers sit in).
public struct McpConfigShape: Equatable, Sendable {
    public enum Problem: Equatable, Sendable {
        case syntax
        case missingPath(String)
        case serversNotObject

        public var message: String {
            switch self {
            case .syntax: return "The configuration JSON contains a syntax error."
            case .missingPath(let path): return "Missing required field at path: \(path)"
            case .serversNotObject: return "Servers configuration must be an object"
            }
        }
    }

    public var serversPath: [String]
    public var template: JSONValue

    public init(serversPath: [String], template: JSONValue) {
        self.serversPath = serversPath
        self.template = template
    }

    /// The editor's document: the template with the servers set at the path.
    public func fullConfig(servers: JSONValue) -> JSONValue {
        guard !serversPath.isEmpty else { return template }
        return Self.setting(servers, at: serversPath[...], in: template)
    }

    /// `validateFullConfig` after parsing the editor text.
    public func validate(_ text: String) -> Problem? {
        guard let value = try? JSONValue.parse(text) else { return .syntax }
        return problem(in: value)
    }

    /// `extractServersForApi`: the servers object to save.
    public func servers(fromText text: String) throws -> JSONValue {
        guard let value = try? JSONValue.parse(text) else { throw Problem.syntax }
        if let problem = problem(in: value) { throw problem }
        return serversPath.reduce(value) { current, key in current.objectMembers?[key] ?? .null }
    }

    private func problem(in value: JSONValue) -> Problem? {
        var current = value
        for key in serversPath {
            guard let members = current.objectMembers else { return .missingPath(serversPath.joined(separator: ".")) }
            current = members[key] ?? .null
        }
        return current.objectMembers == nil ? .serversNotObject : nil
    }

    private static func setting(_ value: JSONValue, at path: ArraySlice<String>, in container: JSONValue) -> JSONValue {
        guard let key = path.first else { return value }
        var members = container.objectMembers ?? [:]
        members[key] = setting(value, at: path.dropFirst(), in: members[key] ?? .object([:]))
        return .object(members)
    }
}

extension McpConfigShape.Problem: Error {}

/// MCP credentials the computer hides from a paired phone (architecture doc
/// §4.1): a hidden value, or the hidden part of a string, reads as
/// `placeholder`. On save the computer puts a hidden value back only where the
/// phone kept its string exactly as it was, at its place or moved within the
/// same object or array of the same server. The phone keeps a hidden string as
/// it is or replaces the whole value; it never edits around a hidden part.
public enum McpHiddenValues {
    public static let placeholder = "__chro_hidden__"

    /// The computer's refusal (`RestoreError`) for the first server whose edited
    /// servers hold a placeholder the computer could not put back; nil otherwise.
    public static func problem(edited: JSONValue, loaded: JSONValue) -> String? {
        guard let servers = edited.objectMembers else { return nil }
        let originals = loaded.objectMembers ?? [:]
        for name in servers.keys.sorted() {
            let kept = originals[name].map(hiddenStrings) ?? []
            let restorable = hiddenStrings(servers[name]!).allSatisfy { edited in
                kept.contains { $0.text == edited.text && ($0.path == edited.path || $0.path.dropLast() == edited.path.dropLast() && $0.path.count == edited.path.count) }
            }
            if !restorable {
                return "MCP server \"\(name)\" holds a hidden value that no longer matches the computer's configuration; edit hidden values on the computer, or replace the whole value"
            }
        }
        return nil
    }

    private enum Step: Hashable {
        case key(String)
        case index(Int)
    }

    /// Every string holding the placeholder, with its path inside the server.
    private static func hiddenStrings(_ value: JSONValue) -> [(path: [Step], text: String)] {
        var found: [(path: [Step], text: String)] = []
        func walk(_ value: JSONValue, _ path: [Step]) {
            switch value {
            case .string(let text) where text.contains(placeholder): found.append((path, text))
            case .array(let items): for (index, item) in items.enumerated() { walk(item, path + [.index(index)]) }
            case .object(let members): for (key, item) in members { walk(item, path + [.key(key)]) }
            default: break
            }
        }
        walk(value, [])
        return found
    }
}
