import ChroAPI
import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// SettingsService over the link: preferences, merge template, editor,
/// appearance, the shared UI state, the executor profile and MCP.
@Suite(.timeLimit(.minutes(1)))
struct LiveSettingsTests {
    let desktop = FakeDesktop()

    private func service() async throws -> (SettingsLiveService, LiveWorkspace) {
        let (phone, calls) = try await desktop.panelPhone()
        return (SettingsLiveService(calls: calls), phone.workspace)
    }

    @Test func preferencesRoundTrip() async throws {
        desktop.reply("GET /rpc/preferences", ["preferences": ["language": "ja", "show_hidden_entries": false]])
        desktop.reply("PUT /rpc/preferences", ["preferences": ["language": "en", "show_hidden_entries": true]])
        let (settings, _) = try await service()
        #expect(try await settings.preferences() == SharedPreferences(language: .ja, showHiddenEntries: false))
        let saved = try await settings.savePreferences(SharedPreferences(language: .en, showHiddenEntries: true))
        #expect(saved == SharedPreferences(language: .en, showHiddenEntries: true))
        #expect(desktop.requests("PUT", "/rpc/preferences").first?.bodyObject as? NSDictionary
            == ["language": "en", "show_hidden_entries": true] as NSDictionary)
    }

    @Test func mergeTemplateEditorAndAccent() async throws {
        desktop.reply("GET /rpc/preferences/merge", ["merge_commit_template": "{{title}}"])
        desktop.reply("PUT /rpc/preferences/merge", ["merge_commit_template": MergeTemplate.defaultTemplate])
        desktop.reply("GET /rpc/preferences/editor", ["editor": ["font_size": 15, "line_height": 1.6, "vim_mode": false]])
        desktop.reply("PUT /rpc/preferences/editor", ["editor": ["font_size": 15, "line_height": 1.8, "vim_mode": false]])
        desktop.reply("GET /rpc/preferences/appearance", ["appearance": ["theme": "system", "accent": "#5B87D6"]])
        desktop.reply("PUT /rpc/preferences/appearance", ["appearance": ["theme": "system", "accent": NSNull()]])
        let (settings, _) = try await service()
        #expect(try await settings.mergeTemplate() == "{{title}}")
        #expect(try await settings.saveMergeTemplate(nil) == MergeTemplate.defaultTemplate)
        #expect((desktop.requests("PUT", "/rpc/preferences/merge").first?.bodyObject as? [String: Any])?["merge_commit_template"] is NSNull)
        #expect(try await settings.editorLineHeight() == 1.6)
        #expect(try await settings.saveEditorLineHeight(1.8) == 1.8)
        #expect(desktop.requests("PUT", "/rpc/preferences/editor").first?.bodyObject as? [String: Double] == ["line_height": 1.8])
        #expect(try await settings.accent() == "#5B87D6")
        #expect(try await settings.saveAccent(nil) == nil)
        #expect((desktop.requests("PUT", "/rpc/preferences/appearance").first?.bodyObject as? [String: Any])?["accent"] is NSNull)
    }

    @Test func nestDelegationsLiveInTheSharedUIState() async throws {
        let (settings, workspace) = try await service()
        #expect(try await settings.nestDelegations() == false)
        try await settings.setNestDelegations(true)
        #expect(desktop.uiState[SessionListPreferences.Key.nestDelegations] as? Bool == true)
        #expect(try await settings.nestDelegations())
        try await eventually("session list follows") { workspace.preferenceState.value.nestDelegations }
    }

    @Test func theDefaultAgentIsTheExecutorProfile() async throws {
        desktop.edit { $0.profile = ["executor": "CODEX"] }
        let (settings, _) = try await service()
        #expect(try await settings.defaultAgent() == .codex)
        try await settings.setDefaultAgent(.pi)
        #expect(desktop.profile["executor"] as? String == "PI")
    }

    nonisolated(unsafe) static let claudeConfig: [String: Any] = [
        "config_path": "/Users/me/.claude.json", "exists": true, "parse_error": NSNull(), "raw_content": NSNull(), "servers_count": 1,
        "mcp_config": ["servers": ["my_server": ["command": "npx", "args": ["-y", "x"]]], "servers_path": ["mcpServers"],
                       "template": ["mcpServers": [:]], "is_toml_config": false],
    ]

    @Test func hiddenCredentialsRoundTripUnchangedAndPartialEditsAreRefusedBeforeSaving() async throws {
        let hidden = McpHiddenValues.placeholder
        let redacted: [String: Any] = [
            "config_path": "/Users/me/.claude.json", "exists": true, "parse_error": NSNull(), "raw_content": NSNull(),
            "mcp_config": ["servers": ["github": ["command": "npx", "args": ["--token=\(hidden)"], "env": ["GITHUB_TOKEN": hidden]]],
                           "servers_path": ["mcpServers"], "template": ["mcpServers": [:]], "is_toml_config": false],
        ]
        desktop.edit { $0.replies["GET /rpc/mcp-config"] = .json(status: 200, FakeDesktop.text(redacted)) }
        desktop.reply("PUT /rpc/mcp-config", redacted)
        let settings = SettingsLiveService(calls: try await desktop.panelPhone().calls)
        let file = try await settings.mcpConfig(for: .claudeCode)
        // The editor shows the computer's placeholder as it is.
        #expect(file.editorText.contains("\"GITHUB_TOKEN\": \"\(hidden)\""))
        #expect(file.problem(editing: file.editorText) == nil)

        // Editing elsewhere keeps the hidden strings byte for byte in the saved body.
        let edited = file.editorText.replacingOccurrences(of: "\"npx\"", with: "\"bunx\"")
        #expect(file.problem(editing: edited) == nil)
        _ = try await settings.saveMcpServers(try file.shape.servers(fromText: edited), for: .claudeCode)
        let body = try #require(desktop.requests("PUT", "/rpc/mcp-config").last?.bodyObject as? [String: Any])
        let github = try #require((body["servers"] as? [String: Any])?["github"] as? [String: Any])
        #expect(github["command"] as? String == "bunx")
        #expect(github["args"] as? [String] == ["--token=\(hidden)"])
        #expect((github["env"] as? [String: String])?["GITHUB_TOKEN"] == hidden)

        // Editing the visible part of a hidden string is refused locally.
        let partial = file.editorText.replacingOccurrences(of: "--token=\(hidden)", with: "--api-token=\(hidden)")
        #expect(file.problem(editing: partial)?.hasPrefix("MCP server \"github\" holds a hidden value") == true)
    }

    @Test func mcpConfigKeepsServerNamesAsWritten() async throws {
        desktop.edit { $0.replies["GET /rpc/mcp-config"] = .json(status: 200, FakeDesktop.text(Self.claudeConfig)) }
        desktop.reply("PUT /rpc/mcp-config", ["config_path": "/Users/me/.codex/config.toml",
                                              "mcp_config": ["servers": ["a_b": ["command": "c"]], "servers_path": ["mcp_servers"], "template": [:], "is_toml_config": true]])
        let (settings, _) = try await service()
        let file = try await settings.mcpConfig(for: .claudeCode)
        #expect(file.configPath == "/Users/me/.claude.json")
        #expect(file.exists)
        #expect(file.shape == McpConfigShape(serversPath: ["mcpServers"], template: .object(["mcpServers": .object([:])])))
        #expect(file.servers == .object(["my_server": .object(["command": .string("npx"), "args": .array([.string("-y"), .string("x")])])]))
        #expect(desktop.requests("GET", "/rpc/mcp-config").first?.query == ["executor": "CLAUDE_CODE"])

        let saved = try await settings.saveMcpServers(.object(["a_b": .object(["command": .string("c")])]), for: .codex)
        #expect(saved.isToml)
        #expect(saved.shape.serversPath == ["mcp_servers"])
        #expect(saved.servers == .object(["a_b": .object(["command": .string("c")])]))
        let put = desktop.requests("PUT", "/rpc/mcp-config").first
        #expect(put?.query == ["executor": "CODEX"])
        #expect(put?.bodyObject as? NSDictionary == ["servers": ["a_b": ["command": "c"]], "executor": "CODEX"] as NSDictionary)
    }

    @Test func mcpStatusIsCheckedForClaudeAndCodexOnly() async throws {
        desktop.reply("GET /rpc/executor/mcp-status", ["ok": false, "servers": [["name": "a", "command": "npx", "connected": false]],
                                                        "error": NSNull(), "message": "1 server failed to start"])
        let (settings, _) = try await service()
        #expect(try await settings.mcpStatus(for: .codex)
            == McpStatus(ok: false, servers: [.init(name: "a", command: "npx", connected: false)], message: "1 server failed to start"))
        #expect(desktop.requests("GET", "/rpc/executor/mcp-status").first?.query == ["executor": "CODEX"])
        await #expect(throws: ServiceError.invalid("Connection checks are not available for pi.")) { try await settings.mcpStatus(for: .pi) }
        #expect(desktop.requests("GET", "/rpc/executor/mcp-status").count == 1)
    }

    @Test func aRefusedSaveIsTheServersText() async throws {
        desktop.edit { $0.failures["/rpc/mcp-config"] = (400, "Invalid MCP configuration") }
        let (settings, _) = try await service()
        await #expect(throws: ServiceError.invalid("Invalid MCP configuration")) { try await settings.saveMcpServers(.object([:]), for: .claudeCode) }
    }
}
