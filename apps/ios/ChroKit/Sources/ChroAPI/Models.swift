import Foundation

// Request and result bodies of crates/server-contract/src/api.rs.
// Field names follow the wire (snake_case is converted by APIDecoder/APIEncoder).

public struct ProjectView: Codable, Equatable, Sendable, Identifiable {
    public let id: UUID
    public let slug: String?
    public let name: String
    public let path: String
}

public struct ProjectList: Codable, Equatable, Sendable { public let projects: [ProjectView] }

public struct SessionRef: Codable, Equatable, Sendable, Identifiable {
    public let id: UUID
    public let slug: String?
    public let title: String
    /// The shortest identifier that addresses this session.
    public var handle: String { slug ?? id.uuidString.lowercased() }
}

public struct SessionState: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let idle = SessionState(rawValue: "idle")
    public static let running = SessionState(rawValue: "running")
    public static let awaitingInput = SessionState(rawValue: "awaiting_input")
    public static func unknown(_ raw: String) -> SessionState { SessionState(rawValue: raw) }
}

public struct TurnView: Codable, Equatable, Sendable {
    public let id: UUID
    public let slug: String?
    /// `pending`, `running`, `completed`, `failed` or `cancelled`.
    public let status: String
    public let startedAt: Date
    public let completedAt: Date?
}

public struct QueuedMessage: Codable, Equatable, Sendable, Identifiable {
    public let id: UUID
    public let prompt: String
    public let createdAt: Date
}

public struct SessionView: Codable, Equatable, Sendable, Identifiable {
    public let id: UUID
    public let slug: String?
    public let title: String
    public let project: ProjectView
    public let state: SessionState
    /// Outcome of the latest turn: `pending`, `in_progress`, `completed`, `failed` or `cancelled`.
    public let status: String
    public let agent: String?
    public let branch: String?
    public let worktree: String?
    public let note: String?
    public let summary: String?
    public let turn: TurnView?
    public let queue: [QueuedMessage]
    public let parent: SessionRef?
    public let children: [SessionRef]
    public let createdAt: Date
    public let updatedAt: Date

    public var handle: String { slug ?? id.uuidString.lowercased() }
}

public struct SessionList: Codable, Equatable, Sendable { public let sessions: [SessionView] }

public struct AgentChoice: Codable, Equatable, Sendable {
    /// `claude`, `codex` or `pi`.
    public var agent: String?
    public var model: String?
    /// `low`, `medium`, `high`, `xhigh`, `max` or `ultra`.
    public var effort: String?
    public init(agent: String? = nil, model: String? = nil, effort: String? = nil) {
        self.agent = agent
        self.model = model
        self.effort = effort
    }
}

/// `#[serde(flatten)]` of the agent choice, absent fields omitted.
public struct NewSession: Encodable, Sendable {
    public var project: String
    public var prompt: String
    public var title: String?
    public var agent: AgentChoice
    public var refs: [String]
    public var start: Bool

    public init(project: String, prompt: String, title: String? = nil, agent: AgentChoice = AgentChoice(), refs: [String] = [], start: Bool = true) {
        self.project = project
        self.prompt = prompt
        self.title = title
        self.agent = agent
        self.refs = refs
        self.start = start
    }

    enum CodingKeys: String, CodingKey { case project, prompt, title, agent, model, effort, refs, start }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(project, forKey: .project)
        try container.encode(prompt, forKey: .prompt)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(agent.agent, forKey: .agent)
        try container.encodeIfPresent(agent.model, forKey: .model)
        try container.encodeIfPresent(agent.effort, forKey: .effort)
        if !refs.isEmpty { try container.encode(refs, forKey: .refs) }
        try container.encode(start, forKey: .start)
    }
}

public struct SessionStarted: Codable, Equatable, Sendable {
    public let session: SessionView
    public let turn: TurnView?
}

public struct Fork: Encodable, Sendable {
    public var prompt: String?
    public init(prompt: String? = nil) { self.prompt = prompt }
}

public struct Forked: Codable, Equatable, Sendable {
    public let session: SessionView
    /// `native` or `digest`.
    public let mode: String
    public let turn: TurnView?
}

public enum WhenBusy: String, Codable, Sendable { case queue, refuse, interrupt }

public struct SendMessage: Encodable, Sendable {
    public var prompt: String
    public var whenBusy: WhenBusy
    public init(prompt: String, whenBusy: WhenBusy = .queue) {
        self.prompt = prompt
        self.whenBusy = whenBusy
    }
}

public struct MessageAccepted: Codable, Equatable, Sendable {
    public let queued: Bool
    public let position: UInt32?
    public let turn: TurnView?
}

public struct EntryKind: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let user = EntryKind(rawValue: "user")
    public static let assistant = EntryKind(rawValue: "assistant")
    public static let tool = EntryKind(rawValue: "tool")
    public static let error = EntryKind(rawValue: "error")
    public static let turnEnd = EntryKind(rawValue: "turn_end")
}

public struct EntryView: Codable, Equatable, Sendable {
    public let cursor: String
    public let turn: String
    public let kind: EntryKind
    public let text: String
    public let tool: String?
    public let status: String?
}

public struct Entries: Codable, Equatable, Sendable {
    public let entries: [EntryView]
    public let nextCursor: String?
}

public struct UpdateSession: Encodable, Sendable {
    public var title: String?
    public var status: String?
    /// An empty string clears the note.
    public var note: String?
    public init(title: String? = nil, status: String? = nil, note: String? = nil) {
        self.title = title
        self.status = status
        self.note = note
    }
}

public struct RefView: Codable, Equatable, Sendable {
    /// `session`, `task`, `file`, `directory`, `skill`, `image`, `fork`, `delegate` or `handoff`.
    public let kind: String
    public let session: SessionRef?
    public let label: String?
    public let createdAt: Date
}

public struct Refs: Codable, Equatable, Sendable { public let refs: [RefView] }

public struct DiffFile: Codable, Equatable, Sendable {
    public let path: String
    public let additions: UInt32
    public let deletions: UInt32
}

public struct DiffView: Codable, Equatable, Sendable {
    public let branch: String
    public let targetBranch: String
    public let baseCommit: String
    public let worktree: String
    public let files: [DiffFile]
}

public struct Merge: Encodable, Sendable {
    public var message: String?
    public init(message: String? = nil) { self.message = message }
}

public struct Merged: Codable, Equatable, Sendable {
    public let mergeCommit: String
    public let targetBranch: String
}

public struct Rebase: Encodable, Sendable {
    public var onto: String?
    public init(onto: String? = nil) { self.onto = onto }
}

public struct Rebased: Codable, Equatable, Sendable { public let onto: String }

/// The tool call awaiting a decision is kept as raw JSON: its shape depends on the tool.
public struct ApprovalView: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let session: SessionRef?
    public let turn: UUID
    public let tool: String
    public let input: JSONValue?
    /// `pending`, `approved`, `denied` or `timed_out`.
    public let status: String
    public let requestedAt: Date?
    public let timeoutAt: Date?
}

public struct ApprovalList: Codable, Equatable, Sendable { public let approvals: [ApprovalView] }

public enum Decision: String, Codable, Sendable { case approve, deny }

public struct Respond: Encodable, Sendable {
    public var decision: Decision
    public var reason: String?
    /// AskUserQuestion answers: question text to chosen option label.
    public var answers: [String: String]

    public init(decision: Decision, reason: String? = nil, answers: [String: String] = [:]) {
        self.decision = decision
        self.reason = reason
        self.answers = answers
    }

    enum CodingKeys: String, CodingKey { case decision, reason, answers }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(decision, forKey: .decision)
        try container.encodeIfPresent(reason, forKey: .reason)
        if !answers.isEmpty { try container.encode(answers, forKey: .answers) }
    }
}

public struct Responded: Codable, Equatable, Sendable { public let status: String }

/// Body of calls that send none.
public struct NoBody: Encodable, Sendable { public init() {} }

/// Arbitrary JSON (serde_json::Value), for tool inputs.
public indirect enum JSONValue: Codable, Equatable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}
