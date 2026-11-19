import ChroAPI
import Foundation

/// One decision an MCP tool-call approval offers; the raw value is the executor's contract.
public enum McpDecision: String, CaseIterable, Equatable, Sendable, Hashable {
    case allow
    case allowSession = "allow_session"
    case allowAlways = "allow_always"
    case deny

    public var title: String {
        switch self {
        case .allow: return "Allow"
        case .allowSession: return "Allow for this session"
        case .allowAlways: return "Always allow"
        case .deny: return "Deny"
        }
    }

    public var detail: String? {
        switch self {
        case .allow: return "Just this once"
        case .allowAlways: return "Stop asking for this tool"
        case .allowSession, .deny: return nil
        }
    }

    /// Deny reads gray and has no submit arrow.
    public var isMuted: Bool { self == .deny }

    /// The coarse outcome recorded on the approval: approved unless denied.
    public var approves: Bool { self != .deny }

    /// The decision rides in the answers so the executor tells "once" from "for the session".
    public var answers: [String: String] { ["decision": rawValue] }
}

/// The prompt of a pending `codex.mcp_tool_call` approval.
public struct McpApprovalPrompt: Equatable, Sendable {
    /// The tool name the executor records on an MCP tool-call approval.
    public static let toolName = "codex.mcp_tool_call"

    public struct Param: Equatable, Sendable, Hashable {
        public var label: String
        public var value: String

        public init(label: String, value: String) {
            self.label = label
            self.value = value
        }

        /// Shown under its label in a monospaced block.
        public var isMultiline: Bool { value.contains("\n") }
    }

    public var server: String
    public var title: String?
    public var message: String
    public var riskLevel: String?
    public var params: [Param]
    public var options: [McpDecision]

    public init(server: String, title: String?, message: String, riskLevel: String?, params: [Param], options: [McpDecision]) {
        self.server = server
        self.title = title
        self.message = message
        self.riskLevel = riskLevel
        self.params = params
        self.options = options
    }

    /// Nil for a payload the user could not understand or answer.
    public static func parse(_ input: JSONValue?) -> McpApprovalPrompt? {
        guard let server = input?["server"]?.stringValue, let message = input?["message"]?.stringValue else { return nil }
        let options = (input?["options"]?.arrayValue ?? []).compactMap { $0.stringValue.flatMap(McpDecision.init(rawValue:)) }
        guard !options.isEmpty else { return nil }
        let params = (input?["params"]?.arrayValue ?? []).compactMap { item -> Param? in
            guard let label = item["label"]?.stringValue, let value = item["value"]?.stringValue else { return nil }
            return Param(label: label, value: value)
        }
        let title = input?["title"]?.stringValue
        return McpApprovalPrompt(server: server, title: title?.isEmpty == false ? title : nil, message: message,
                                 riskLevel: input?["risk_level"]?.stringValue, params: params, options: options)
    }

    /// `{title} · {server}`, or the server alone.
    public var headerLabel: String { title.map { "\($0) · \(server)" } ?? server }

    /// The "Outside the sandbox" badge: any risk level other than low.
    public var isOutsideSandbox: Bool { riskLevel.map { $0 != "low" } ?? false }
}
