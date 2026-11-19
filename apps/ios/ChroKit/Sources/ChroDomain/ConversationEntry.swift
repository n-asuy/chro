import ChroAPI
import Foundation

/// One entry of a session's conversation, as the desktop's normalized log
/// entries carry it (crates/log-types/src/normalized.rs, session/types/normalized.ts).
public struct ConversationEntry: Identifiable, Equatable, Sendable, Hashable {
    /// `<runID>:<entry index>`, the desktop's display key; unique across the conversation.
    public var id: String
    /// The run (task run) that produced the entry; a turn's fork anchor.
    public var runID: String
    public var timestamp: Date?
    public var kind: ConversationEntryKind
    /// Copied from the session this one continues; rendered dimmed above the fork line.
    public var isInherited: Bool

    public init(id: String, runID: String, timestamp: Date? = nil, kind: ConversationEntryKind, isInherited: Bool = false) {
        self.id = id
        self.runID = runID
        self.timestamp = timestamp
        self.kind = kind
        self.isInherited = isInherited
    }
}

public enum ConversationEntryKind: Equatable, Sendable, Hashable {
    /// The prompt as sent, including its `<context>`, `<skills_context>` and image markup.
    case userMessage(String)
    case assistantMessage(String)
    case thinking(String)
    /// The trailing "agent is working" sentinel; the text is an optional progress message.
    case loading(String)
    case toolUse(ToolUse)
    case systemMessage(String)
    case errorMessage(String, ConversationErrorKind)
    case stdout(String)
    case stderr(String)
}

public enum ConversationErrorKind: String, Equatable, Sendable, Hashable {
    case setupRequired = "setup_required"
    case malformedToolCall = "malformed_tool_call"
    case apiError = "api_error"
    case other
}

public struct ToolUse: Equatable, Sendable, Hashable {
    /// The agent's raw tool name, e.g. `Bash`, `Read`, `mcp__github__create_issue`.
    public var toolName: String
    public var action: ToolAction
    public var status: ToolStatus
    /// The entry's content line (the processor's concise summary).
    public var content: String

    public init(toolName: String, action: ToolAction, status: ToolStatus, content: String = "") {
        self.toolName = toolName
        self.action = action
        self.status = status
        self.content = content
    }
}

public enum ToolAction: Equatable, Sendable, Hashable {
    case commandRun(command: String, result: CommandResult?)
    case fileRead(path: String)
    case fileEdit(path: String, changes: [ToolFileChange])
    case search(query: String)
    case webFetch(url: String)
    case tool(name: String, arguments: JSONValue?, result: JSONValue?)
    case taskCreate(description: String)
    case planPresentation(plan: String)
    case todoManagement(todos: [TodoItem], operation: String)
    case other(description: String)
}

public struct CommandResult: Equatable, Sendable, Hashable {
    public enum ExitStatus: Equatable, Sendable, Hashable {
        case exitCode(Int)
        case success(Bool)
    }

    public var exitStatus: ExitStatus?
    public var output: String?

    public init(exitStatus: ExitStatus? = nil, output: String? = nil) {
        self.exitStatus = exitStatus
        self.output = output
    }
}

public enum ToolFileChange: Equatable, Sendable, Hashable {
    case write(content: String)
    case delete
    case rename(newPath: String)
    case edit(unifiedDiff: String)
}

public struct TodoItem: Equatable, Sendable, Hashable {
    public var content: String
    public var status: String

    public init(content: String, status: String) {
        self.content = content
        self.status = status
    }
}

public enum ToolStatus: Equatable, Sendable, Hashable {
    case created
    case success
    case failed
    case denied(reason: String?)
    case pendingApproval(approvalID: String, timeoutAt: Date?)
    case timedOut

    public var isPendingApproval: Bool {
        if case .pendingApproval = self { return true }
        return false
    }
}

extension JSONValue: Hashable {
    public func hash(into hasher: inout Hasher) {
        switch self {
        case .null: hasher.combine(0)
        case .bool(let value): hasher.combine(value)
        case .number(let value): hasher.combine(value)
        case .string(let value): hasher.combine(value)
        case .array(let value): hasher.combine(value)
        case .object(let value):
            for key in value.keys.sorted() {
                hasher.combine(key)
                hasher.combine(value[key])
            }
        }
    }
}

extension JSONValue {
    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public subscript(key: String) -> JSONValue? { objectValue?[key] }
}
