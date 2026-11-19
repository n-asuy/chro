import ChroAPI
import ChroDomain
import Foundation

/// SettingsService over the paired desktop (lib/preferences-client.ts,
/// lib/mcp-config-client.ts, lib/executor-client.ts, the shared UI state).
final class SettingsLiveService: SettingsService, @unchecked Sendable {
    private let calls: PanelLiveCalls

    init(calls: PanelLiveCalls) { self.calls = calls }

    // MARK: Preferences

    static func fetchPreferences(_ calls: PanelLiveCalls) async throws -> SharedPreferences {
        try calls.decode(PreferencesEnvelope.self, try await calls.body(.get, ["rpc", "preferences"])).preferences.shared
    }

    func preferences() async throws -> SharedPreferences { try await Self.fetchPreferences(calls) }

    func savePreferences(_ preferences: SharedPreferences) async throws -> SharedPreferences {
        let body: [String: Any] = ["language": preferences.language.rawValue, "show_hidden_entries": preferences.showHiddenEntries,
                                   "analytics_enabled": preferences.analyticsEnabled]
        return try calls.decode(PreferencesEnvelope.self, try await calls.body(.put, ["rpc", "preferences"], body: body)).preferences.shared
    }

    func mergeTemplate() async throws -> String {
        try calls.decode(MergeWire.self, try await calls.body(.get, ["rpc", "preferences", "merge"])).mergeCommitTemplate
    }

    func saveMergeTemplate(_ stored: String?) async throws -> String {
        let body: [String: Any] = ["merge_commit_template": stored ?? NSNull()]
        return try calls.decode(MergeWire.self, try await calls.body(.put, ["rpc", "preferences", "merge"], body: body)).mergeCommitTemplate
    }

    func editorLineHeight() async throws -> Double {
        try calls.decode(EditorEnvelope.self, try await calls.body(.get, ["rpc", "preferences", "editor"])).editor.lineHeight
    }

    func saveEditorLineHeight(_ value: Double) async throws -> Double {
        try calls.decode(EditorEnvelope.self, try await calls.body(.put, ["rpc", "preferences", "editor"], body: ["line_height": value])).editor.lineHeight
    }

    func accent() async throws -> String? {
        try calls.decode(AppearanceEnvelope.self, try await calls.body(.get, ["rpc", "preferences", "appearance"])).appearance.accent
    }

    /// nil sends `accent: null`, which restores the default accent.
    func saveAccent(_ hex: String?) async throws -> String? {
        let body: [String: Any] = ["accent": hex ?? NSNull()]
        return try calls.decode(AppearanceEnvelope.self, try await calls.body(.put, ["rpc", "preferences", "appearance"], body: body)).appearance.accent
    }

    // MARK: Workspace

    /// Off unless the desktop stored it (the desktop's default).
    func nestDelegations() async throws -> Bool {
        let state = try await calls.workspace.fetchUIState()
        calls.workspace.replaceUIState(state)
        if case .bool(let on)? = state[SessionListPreferences.Key.nestDelegations] { return on }
        return false
    }

    func setNestDelegations(_ on: Bool) async throws {
        try await calls.workspace.writeUIState([SessionListPreferences.Key.nestDelegations: .bool(on)])
    }

    // MARK: Agents

    func defaultAgent() async throws -> AgentKind {
        let wire = try calls.decode(ProfileEnvelope.self, try await calls.body(.get, ["rpc", "executor", "profile"]))
        return AgentKind(rawValue: wire.profile.executor) ?? .claudeCode
    }

    /// The shared profile write, so the session list's default agent follows.
    func setDefaultAgent(_ agent: AgentKind) async throws {
        try await calls.workspace.setDefaultAgent(agent)
    }

    func mcpConfig(for agent: AgentKind) async throws -> McpConfigFile {
        let data = try await calls.body(.get, ["rpc", "mcp-config"], query: ["executor": agent.rawValue])
        let wire = try calls.decode(McpConfigWire.self, data)
        return McpConfigFile(configPath: wire.configPath, exists: wire.exists, shape: wire.mcpConfig.shape, servers: wire.mcpConfig.servers,
                             isToml: wire.mcpConfig.isTomlConfig ?? false, parseError: wire.parseError)
    }

    func saveMcpServers(_ servers: JSONValue, for agent: AgentKind) async throws -> McpConfigFile {
        let body = JSONValue.object(["servers": servers, "executor": .string(agent.rawValue)])
        let data = try await calls.body(.put, ["rpc", "mcp-config"], query: ["executor": agent.rawValue],
                                        body: try JSONSerialization.jsonObject(with: try JSONEncoder().encode(body)))
        let wire = try calls.decode(SavedMcpWire.self, data)
        return McpConfigFile(configPath: wire.configPath, exists: true, shape: wire.mcpConfig.shape, servers: wire.mcpConfig.servers,
                             isToml: wire.mcpConfig.isTomlConfig ?? false, parseError: nil)
    }

    /// pi has no MCP connection check on the desktop either.
    func mcpStatus(for agent: AgentKind) async throws -> McpStatus {
        guard McpStatus.isSupported(agent) else {
            throw ServiceError.invalid("Connection checks are not available for \(agent.displayName).")
        }
        let data = try await calls.body(.get, ["rpc", "executor", "mcp-status"], query: ["executor": agent.rawValue])
        let wire = try calls.decode(McpStatusWire.self, data)
        return McpStatus(ok: wire.ok, servers: wire.servers.map { McpStatus.Server(name: $0.name, command: $0.command, connected: $0.connected) },
                         message: wire.message ?? wire.error)
    }

    // MARK: Wire

    private struct PreferencesEnvelope: Decodable {
        struct Preferences: Decodable {
            let language: String
            let showHiddenEntries: Bool
            let analyticsEnabled: Bool

            enum CodingKeys: String, CodingKey {
                case language, showHiddenEntries = "show_hidden_entries", analyticsEnabled = "analytics_enabled"
            }

            var shared: SharedPreferences {
                SharedPreferences(language: SharedPreferences.Language(rawValue: language) ?? .en,
                                  showHiddenEntries: showHiddenEntries, analyticsEnabled: analyticsEnabled)
            }
        }

        let preferences: Preferences
    }

    private struct MergeWire: Decodable {
        let mergeCommitTemplate: String
        enum CodingKeys: String, CodingKey { case mergeCommitTemplate = "merge_commit_template" }
    }

    private struct EditorEnvelope: Decodable {
        struct Editor: Decodable {
            let lineHeight: Double
            enum CodingKeys: String, CodingKey { case lineHeight = "line_height" }
        }

        let editor: Editor
    }

    private struct AppearanceEnvelope: Decodable {
        struct Appearance: Decodable { let accent: String? }
        let appearance: Appearance
    }

    private struct ProfileEnvelope: Decodable {
        struct Profile: Decodable { let executor: String }
        let profile: Profile
    }

    /// The `mcp_config` object (`McpConfig`); decoded without key conversion so
    /// server names and Codex's `mcp_servers` keep their spelling.
    private struct McpConfigBody: Decodable {
        let servers: JSONValue
        let serversPath: [String]
        let template: JSONValue
        let isTomlConfig: Bool?

        enum CodingKeys: String, CodingKey {
            case servers, serversPath = "servers_path", template, isTomlConfig = "is_toml_config"
        }

        var shape: McpConfigShape { McpConfigShape(serversPath: serversPath, template: template) }
    }

    private struct McpConfigWire: Decodable {
        let configPath: String
        let exists: Bool
        let mcpConfig: McpConfigBody
        let parseError: String?

        enum CodingKeys: String, CodingKey {
            case configPath = "config_path", exists, mcpConfig = "mcp_config", parseError = "parse_error"
        }
    }

    private struct SavedMcpWire: Decodable {
        let configPath: String
        let mcpConfig: McpConfigBody

        enum CodingKeys: String, CodingKey { case configPath = "config_path", mcpConfig = "mcp_config" }
    }

    private struct McpStatusWire: Decodable {
        struct Server: Decodable { let name: String; let command: String; let connected: Bool }
        let ok: Bool
        let servers: [Server]
        let error: String?
        let message: String?
    }
}
