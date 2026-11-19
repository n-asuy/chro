import ChroAPI
import ChroDomain
import Foundation

/// SettingsService with the mock's captured settings. Hand-made (not captured):
/// the Codex and pi MCP files and every MCP connection-check result.
final class SettingsFixtureService: SettingsService, @unchecked Sendable {
    private let lock = NSLock()
    private var shared = SharedPreferences(language: .en, showHiddenEntries: true, analyticsEnabled: true)
    private var template: String?
    private var lineHeight = EditorChoices.defaultLineHeight
    private var accentHex: String?
    private var nest = true
    private var agent = AgentKind.claudeCode
    private var mcp: [AgentKind: McpConfigFile] = SettingsFixtureService.capturedMcp

    /// Every scenario shares the captured settings.
    init(scenario: FixtureScenario) {}

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    func preferences() async throws -> SharedPreferences { locked { shared } }

    func savePreferences(_ preferences: SharedPreferences) async throws -> SharedPreferences {
        locked { shared = preferences; return shared }
    }

    func mergeTemplate() async throws -> String { locked { template ?? MergeTemplate.defaultTemplate } }

    func saveMergeTemplate(_ stored: String?) async throws -> String {
        locked { template = stored; return stored ?? MergeTemplate.defaultTemplate }
    }

    func editorLineHeight() async throws -> Double { locked { lineHeight } }

    func saveEditorLineHeight(_ value: Double) async throws -> Double { locked { lineHeight = value; return value } }

    func accent() async throws -> String? { locked { accentHex } }

    func saveAccent(_ hex: String?) async throws -> String? { locked { accentHex = hex; return hex } }

    func nestDelegations() async throws -> Bool { locked { nest } }

    func setNestDelegations(_ on: Bool) async throws { locked { nest = on } }

    func defaultAgent() async throws -> AgentKind { locked { agent } }

    func setDefaultAgent(_ agent: AgentKind) async throws { locked { self.agent = agent } }

    func mcpConfig(for agent: AgentKind) async throws -> McpConfigFile {
        try locked {
            guard let file = mcp[agent] else { throw ServiceError.notFound("The MCP configuration") }
            return file
        }
    }

    func saveMcpServers(_ servers: JSONValue, for agent: AgentKind) async throws -> McpConfigFile {
        try locked {
            guard var file = mcp[agent] else { throw ServiceError.notFound("The MCP configuration") }
            file.servers = servers
            file.exists = true
            file.parseError = nil
            mcp[agent] = file
            return file
        }
    }

    func mcpStatus(for agent: AgentKind) async throws -> McpStatus {
        try await Task.sleep(for: .milliseconds(600))
        return try locked {
            guard McpStatus.isSupported(agent), let file = mcp[agent] else {
                throw ServiceError.invalid("Connection checks are not available for \(agent.displayName).")
            }
            guard case .object(let servers) = file.servers else { return McpStatus(ok: true, servers: []) }
            return McpStatus(ok: true, servers: servers.keys.sorted().map { name in
                let command: String
                if case .object(let entry) = servers[name], case .string(let value)? = entry["command"] ?? entry["url"] {
                    command = value
                } else {
                    command = ""
                }
                return McpStatus.Server(name: name, command: command, connected: true)
            })
        }
    }

    /// Claude Code's file as the computer answers a phone (its API token hidden,
    /// architecture doc §4.1);
    /// Codex's and pi's are hand-made empty files at their default paths.
    private static let capturedMcp: [AgentKind: McpConfigFile] = {
        let claudeServers = JSONValue.object([
            "actors-mcp-server": .object([
                "args": .array([.string("-y"), .string("@apify/actors-mcp-server")]),
                "command": .string("npx"),
                "env": .object(["APIFY_TOKEN": .string(McpHiddenValues.placeholder)]),
            ]),
            "freee": .object(["type": .string("http"), "url": .string("https://mcp.freee.co.jp/mcp")]),
            "open-pencil": .object(["command": .string("openpencil-mcp")]),
        ])
        return [
            .claudeCode: McpConfigFile(configPath: "/Users/me/.claude.json", exists: true,
                                       shape: McpConfigShape(serversPath: ["mcpServers"], template: .object([:])), servers: claudeServers),
            .codex: McpConfigFile(configPath: "/Users/me/.codex/config.toml", exists: false,
                                  shape: McpConfigShape(serversPath: ["mcp_servers"], template: .object([:])), servers: .object([:]), isToml: true),
            .pi: McpConfigFile(configPath: "/Users/me/.pi/agent/mcp.json", exists: false,
                               shape: McpConfigShape(serversPath: ["mcpServers"], template: .object([:])), servers: .object([:])),
        ]
    }()
}
