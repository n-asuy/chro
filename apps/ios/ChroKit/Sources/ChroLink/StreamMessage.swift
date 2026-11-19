import ChroAPI
import Foundation

/// One message of a `/streams/*` subscription as the desktop's WebSocket sends
/// it (crates/log-types `LogEntry`, tagged `{type, payload}`), or the
/// `{"error": ...}` a stream sends when it fails.
public enum StreamMessage: Equatable, Sendable {
    /// `json_patch`: RFC 6902 operations against the stream's document.
    case patch([JSONValue])
    /// `finished`: the source has nothing more to send.
    case finished
    /// `{"error": "..."}`.
    case failure(String)
    /// Any other entry (`stdout`, `session_id`, ...), with its payload.
    case other(type: String, payload: JSONValue)

    public init(_ data: Data) throws {
        guard case .object(let object) = try JSONDecoder().decode(JSONValue.self, from: data) else {
            throw LinkError.malformedResponse("stream message is not an object")
        }
        if case .string(let error)? = object["error"] {
            self = .failure(error)
            return
        }
        guard case .string(let type)? = object["type"] else { throw LinkError.malformedResponse("stream message type") }
        switch type {
        case "json_patch":
            guard case .array(let operations)? = object["payload"] else { throw LinkError.malformedResponse("json_patch payload") }
            self = .patch(operations)
        case "finished":
            self = .finished
        default:
            self = .other(type: type, payload: object["payload"] ?? .null)
        }
    }
}

/// RFC 6902 `add`, `replace` and `remove` (the operations the desktop's streams
/// emit) over a JSON document, with RFC 6901 pointers. A `replace` of a missing
/// object member sets it: every stream opens with `replace /<collection>` on an
/// empty document.
public enum JSONPatch {
    public static func apply(_ operations: [JSONValue], to document: inout JSONValue) throws {
        for operation in operations {
            guard case .object(let fields) = operation, case .string(let op)? = fields["op"], case .string(let path)? = fields["path"] else {
                throw LinkError.malformedResponse("patch operation")
            }
            let tokens = try pointer(path)
            switch op {
            case "add":
                guard let value = fields["value"] else { throw LinkError.malformedResponse("add without value") }
                try update(&document, at: tokens[...], op: .add(value))
            case "replace":
                guard let value = fields["value"] else { throw LinkError.malformedResponse("replace without value") }
                try update(&document, at: tokens[...], op: .replace(value))
            case "remove":
                try update(&document, at: tokens[...], op: .remove)
            default:
                throw LinkError.malformedResponse("unsupported patch op \(op)")
            }
        }
    }

    private enum Edit {
        case add(JSONValue)
        case replace(JSONValue)
        case remove
    }

    /// RFC 6901: `""` is the whole document; `~1` is `/` and `~0` is `~`.
    public static func pointer(_ path: String) throws -> [String] {
        guard !path.isEmpty else { return [] }
        guard path.hasPrefix("/") else { throw LinkError.malformedResponse("patch path \(path)") }
        return path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map {
            $0.replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
        }
    }

    private static func update(_ node: inout JSONValue, at tokens: ArraySlice<String>, op: Edit) throws {
        guard let token = tokens.first else {
            switch op {
            case .add(let value), .replace(let value): node = value
            case .remove: throw LinkError.malformedResponse("cannot remove the whole document")
            }
            return
        }
        let rest = tokens.dropFirst()
        switch node {
        case .object(var object):
            if rest.isEmpty {
                switch op {
                case .add(let value), .replace(let value): object[token] = value
                case .remove:
                    guard object.removeValue(forKey: token) != nil else { throw LinkError.malformedResponse("remove of missing \(token)") }
                }
            } else {
                guard var child = object[token] else { throw LinkError.malformedResponse("missing \(token)") }
                try update(&child, at: rest, op: op)
                object[token] = child
            }
            node = .object(object)
        case .array(var array):
            if rest.isEmpty, case .add(let value) = op {
                if token == "-" {
                    array.append(value)
                } else {
                    guard let index = Int(token), (0...array.count).contains(index) else { throw LinkError.malformedResponse("index \(token)") }
                    array.insert(value, at: index)
                }
            } else {
                guard let index = Int(token), array.indices.contains(index) else { throw LinkError.malformedResponse("index \(token)") }
                if rest.isEmpty {
                    switch op {
                    case .replace(let value): array[index] = value
                    case .remove: array.remove(at: index)
                    case .add: break
                    }
                } else {
                    try update(&array[index], at: rest, op: op)
                }
            }
            node = .array(array)
        default:
            throw LinkError.malformedResponse("path through a scalar at \(token)")
        }
    }
}
