import ChroDomain
import ChroServices
import Foundation
import Observation

/// The state behind every Settings pane: what the desktop shares (loaded
/// from `SettingsService`) and the save states the panes show. Lives as long
/// as the Settings sheet, including while an option list replaces it.
@MainActor @Observable
final class SettingsModel {
    enum SaveState: Equatable {
        case idle, saving, saved
        case failed(String)
    }

    let services: PanelServices
    private var settings: any SettingsService { services.settings }

    // Shared preferences (General, Workspace).
    private(set) var preferences: SharedPreferences?
    private(set) var preferencesError: String?
    private(set) var nestDelegations: Bool?
    // Merge template (Workspace).
    var templateDraft = ""
    private(set) var savedTemplate: String?
    private(set) var templateSave = SaveState.idle
    // Appearance and Editor.
    private(set) var accent: String?
    private(set) var lineHeight: Double?
    // Agents.
    private(set) var defaultAgent: AgentKind?
    private(set) var cliStatus: CliStatus?
    private(set) var cliLoading = false
    private(set) var cliError = false
    // MCP.
    private(set) var mcpTarget = AgentKind.claudeCode
    private var mcpTargetChosen = false
    private(set) var mcpFile: McpConfigFile?
    private(set) var mcpLoading = false
    private(set) var mcpLoadError: String?
    var mcpText = "" { didSet { if mcpText != oldValue { validateMcp() } } }
    private(set) var mcpInitialText = ""
    private(set) var mcpValidation: String?
    private(set) var mcpSave = SaveState.idle
    private(set) var mcpStatus: McpStatus?
    private(set) var mcpStatusLoading = false
    private(set) var mcpStatusError: String?
    private(set) var mcpCheckedAt: Date?

    init(services: PanelServices) { self.services = services }

    var mcpDirty: Bool { mcpText != mcpInitialText }

    // MARK: - Loading

    func load(_ pane: SettingsPane) async {
        switch pane {
        case .general, .workspace:
            await loadPreferences()
            if pane == .workspace {
                if nestDelegations == nil { nestDelegations = try? await settings.nestDelegations() }
                if savedTemplate == nil, let template = try? await settings.mergeTemplate() {
                    savedTemplate = template
                    templateDraft = template
                }
            }
        case .appearance:
            accent = try? await settings.accent()
        case .editor:
            if lineHeight == nil { lineHeight = (try? await settings.editorLineHeight()) ?? EditorChoices.defaultLineHeight }
        case .notifications, .developer:
            break
        case .mcp:
            if defaultAgent == nil { defaultAgent = try? await settings.defaultAgent() }
            if !mcpTargetChosen, let defaultAgent { mcpTarget = defaultAgent }
            if mcpFile == nil { await loadMcp() }
        case .agents:
            if defaultAgent == nil { defaultAgent = try? await settings.defaultAgent() }
            if cliStatus == nil { await refreshCli() }
        }
    }

    private func loadPreferences() async {
        guard preferences == nil else { return }
        do {
            preferences = try await settings.preferences()
            preferencesError = nil
        } catch {
            preferencesError = Self.message(error)
        }
    }

    // MARK: - General and Workspace

    func setLanguage(_ language: SharedPreferences.Language) async {
        guard var next = preferences, next.language != language else { return }
        next.language = language
        await savePreferences(next)
    }

    func setShowHiddenEntries(_ on: Bool) async {
        guard var next = preferences else { return }
        next.showHiddenEntries = on
        await savePreferences(next)
    }

    /// Optimistic, then the server's answer; a failure restores what was saved.
    private func savePreferences(_ next: SharedPreferences) async {
        let previous = preferences
        preferences = next
        do {
            preferences = try await settings.savePreferences(next)
            preferencesError = nil
        } catch {
            let actual = await reread(after: error) { try await self.settings.preferences() }
            preferences = actual ?? previous
            preferencesError = actual == next ? nil : Self.message(error)
        }
    }

    func setNestDelegations(_ on: Bool) async {
        let previous = nestDelegations
        nestDelegations = on
        do {
            try await settings.setNestDelegations(on)
        } catch {
            nestDelegations = await reread(after: error) { try await self.settings.nestDelegations() } ?? previous
        }
    }

    /// Saves the template when it changed (on leaving the field), then shows "Saved" for 1.5 s.
    func commitTemplate() async {
        guard templateDraft != savedTemplate else { return }
        templateSave = .saving
        do {
            _ = try await settings.saveMergeTemplate(MergeTemplate.storedValue(templateDraft))
            savedTemplate = templateDraft
            templateSave = .saved
            try? await Task.sleep(for: .milliseconds(1500))
            if templateSave == .saved { templateSave = .idle }
        } catch {
            if let actual = await reread(after: error, { try await self.settings.mergeTemplate() }), actual == templateDraft {
                savedTemplate = actual
                templateSave = .saved
            } else {
                templateSave = .failed(Self.message(error, fallback: "Failed to save"))
            }
        }
    }

    func resetTemplate() async {
        templateDraft = MergeTemplate.defaultTemplate
        await commitTemplate()
    }

    // MARK: - Appearance and Editor

    func setAccent(_ hex: String?) async {
        let previous = accent
        accent = hex
        do {
            accent = try await settings.saveAccent(hex)
        } catch {
            accent = await reread(after: error) { try await self.settings.accent() } ?? previous
        }
    }

    func setLineHeight(_ value: Double) async {
        let previous = lineHeight
        lineHeight = value
        do {
            lineHeight = try await settings.saveEditorLineHeight(value)
        } catch {
            lineHeight = await reread(after: error) { try await self.settings.editorLineHeight() } ?? previous
        }
    }

    // MARK: - Agents

    func setDefaultAgent(_ agent: AgentKind) async {
        let previous = defaultAgent
        defaultAgent = agent
        do {
            try await settings.setDefaultAgent(agent)
        } catch {
            defaultAgent = await reread(after: error) { try await self.settings.defaultAgent() } ?? previous
        }
    }

    func refreshCli() async {
        cliLoading = true
        defer { cliLoading = false }
        do {
            cliStatus = try await services.system.cliStatus()
            cliError = false
        } catch {
            cliError = true
        }
    }

    // MARK: - MCP

    func selectMcpTarget(_ agent: AgentKind) async {
        guard agent != mcpTarget else { return }
        mcpTargetChosen = true
        mcpTarget = agent
        mcpStatus = nil
        mcpStatusError = nil
        mcpCheckedAt = nil
        await loadMcp()
    }

    /// Reads the file again; unsaved edits are discarded.
    func loadMcp() async {
        mcpLoading = true
        mcpLoadError = nil
        mcpSave = .idle
        defer { mcpLoading = false }
        do {
            let file = try await settings.mcpConfig(for: mcpTarget)
            mcpFile = file
            mcpInitialText = file.editorText
            mcpText = file.editorText
            mcpValidation = file.parseError
        } catch {
            mcpLoadError = Self.message(error, fallback: "An error occurred while loading MCP settings.")
        }
    }

    func saveMcp() async {
        guard let file = mcpFile, mcpDirty, mcpValidation == nil else { return }
        do {
            let servers = try file.shape.servers(fromText: mcpText)
            mcpSave = .saving
            let saved = try await settings.saveMcpServers(servers, for: mcpTarget)
            mcpFile = saved
            mcpInitialText = saved.editorText
            mcpText = saved.editorText
            mcpValidation = nil
            mcpSave = .saved
            try? await Task.sleep(for: .seconds(2))
            if mcpSave == .saved { mcpSave = .idle }
        } catch let problem as McpConfigShape.Problem {
            mcpSave = .failed(problem.message)
        } catch {
            // Saved after all: show the file as the computer has it; else keep the edits.
            if let actual = await reread(after: error, { try await self.settings.mcpConfig(for: self.mcpTarget) }),
               let sent = try? file.shape.servers(fromText: mcpText), actual.servers == sent {
                mcpFile = actual
                mcpInitialText = actual.editorText
                mcpText = actual.editorText
                mcpSave = .saved
            } else {
                mcpSave = .failed(Self.message(error, fallback: "An error occurred while saving MCP settings."))
            }
        }
    }

    func checkMcpStatus() async {
        guard McpStatus.isSupported(mcpTarget) else { return }
        mcpStatusLoading = true
        mcpStatusError = nil
        defer { mcpStatusLoading = false }
        do {
            let result = try await settings.mcpStatus(for: mcpTarget)
            if result.ok {
                mcpStatus = result
            } else {
                mcpStatus = McpStatus(ok: false, servers: [])
                mcpStatusError = result.message ?? "Failed to check connection status."
            }
        } catch {
            mcpStatus = nil
            mcpStatusError = Self.message(error, fallback: "Failed to check connection status.")
        }
        mcpCheckedAt = Date()
    }

    /// After a save whose answer was lost (deadline, disconnect), the value the computer
    /// actually has, so the pane shows what happened; nil after any other failure.
    private func reread<T: Sendable>(after error: any Error, _ read: () async throws -> T) async -> T? {
        guard (error as? ServiceError)?.isOutcomeUnknown == true else { return nil }
        return try? await read()
    }

    private func validateMcp() {
        guard let file = mcpFile else { return }
        mcpValidation = file.problem(editing: mcpText)
    }

    private static func message(_ error: any Error, fallback: String? = nil) -> String {
        if let service = error as? ServiceError { return service.message }
        return fallback ?? error.localizedDescription
    }
}
