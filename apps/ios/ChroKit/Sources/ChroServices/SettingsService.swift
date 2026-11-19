import ChroAPI
import ChroDomain
import Foundation

/// `/rpc/preferences`: the shared preferences the desktop's General and Workspace panes edit.
public struct SharedPreferences: Equatable, Sendable {
    public enum Language: String, Sendable, CaseIterable {
        case en, ja

        public var label: String { self == .en ? "English" : "日本語" }
    }

    public var language: Language
    public var showHiddenEntries: Bool
    public var analyticsEnabled: Bool

    public init(language: Language = .en, showHiddenEntries: Bool = false, analyticsEnabled: Bool = true) {
        self.language = language
        self.showHiddenEntries = showHiddenEntries
        self.analyticsEnabled = analyticsEnabled
    }
}

/// `/rpc/mcp-config?executor=`: one agent's MCP configuration file.
public struct McpConfigFile: Equatable, Sendable {
    /// Where saving writes, as the desktop shows it.
    public var configPath: String
    public var exists: Bool
    public var shape: McpConfigShape
    public var servers: JSONValue
    /// Codex keeps TOML; the editor shows a JSON view of it.
    public var isToml: Bool
    /// The file exists but could not be read as configuration.
    public var parseError: String?

    public init(configPath: String, exists: Bool, shape: McpConfigShape, servers: JSONValue, isToml: Bool = false, parseError: String? = nil) {
        self.configPath = configPath
        self.exists = exists
        self.shape = shape
        self.servers = servers
        self.isToml = isToml
        self.parseError = parseError
    }

    /// The editor's text: the full config, two-space JSON.
    public var editorText: String { shape.fullConfig(servers: servers).prettyPrinted() }

    /// Why `text` cannot be saved: invalid JSON or shape (the desktop's checks), or a
    /// hidden credential edited around (the computer's restore rule); nil when it can.
    public func problem(editing text: String) -> String? {
        if let problem = shape.validate(text) { return problem.message }
        guard let edited = try? shape.servers(fromText: text) else { return nil }
        return McpHiddenValues.problem(edited: edited, loaded: servers)
    }
}

/// `/rpc/executor/mcp-status?executor=`.
public struct McpStatus: Equatable, Sendable {
    public struct Server: Equatable, Sendable, Identifiable {
        public var name: String
        public var command: String
        public var connected: Bool
        public var id: String { name }

        public init(name: String, command: String, connected: Bool) {
            self.name = name
            self.command = command
            self.connected = connected
        }
    }

    public var ok: Bool
    public var servers: [Server]
    public var message: String?

    public init(ok: Bool, servers: [Server], message: String? = nil) {
        self.ok = ok
        self.servers = servers
        self.message = message
    }

    /// Agents whose connections the desktop can check.
    public static func isSupported(_ agent: AgentKind) -> Bool { agent != .pi }
}

/// The settings the phone shares with the desktop. Theme, the editor's font
/// size and notifications stay on the phone (`DeviceSettings`).
public protocol SettingsService: Sendable {
    /// GET /rpc/preferences.
    func preferences() async throws -> SharedPreferences
    /// PUT /rpc/preferences; returns what the server stored.
    func savePreferences(_ preferences: SharedPreferences) async throws -> SharedPreferences
    /// GET /rpc/preferences/merge.
    func mergeTemplate() async throws -> String
    /// PUT /rpc/preferences/merge with `MergeTemplate.storedValue` (nil restores the default); returns the effective template.
    func saveMergeTemplate(_ stored: String?) async throws -> String
    /// GET /rpc/preferences/editor `line_height`.
    func editorLineHeight() async throws -> Double
    /// PUT /rpc/preferences/editor `{line_height}`.
    func saveEditorLineHeight(_ value: Double) async throws -> Double
    /// GET /rpc/preferences/appearance `accent` (nil is the default accent).
    func accent() async throws -> String?
    /// PUT /rpc/preferences/appearance `{accent}`.
    func saveAccent(_ hex: String?) async throws -> String?
    /// The session list's `workspace-layout:nest-delegations:v1` (/rpc/ui-state).
    func nestDelegations() async throws -> Bool
    func setNestDelegations(_ on: Bool) async throws
    /// GET /rpc/executor/profile: the agent new sessions start with.
    func defaultAgent() async throws -> AgentKind
    /// PUT /rpc/executor/profile.
    func setDefaultAgent(_ agent: AgentKind) async throws
    /// GET /rpc/mcp-config?executor=.
    func mcpConfig(for agent: AgentKind) async throws -> McpConfigFile
    /// PUT /rpc/mcp-config?executor= `{servers, executor}`; returns the file as saved.
    func saveMcpServers(_ servers: JSONValue, for agent: AgentKind) async throws -> McpConfigFile
    /// GET /rpc/executor/mcp-status?executor=.
    func mcpStatus(for agent: AgentKind) async throws -> McpStatus
}
