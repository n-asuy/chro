import ChroDomain
import ChroServices
import SwiftUI

/// Settings > MCP: target agent, connection status, and the JSON editor.
struct McpPane: View {
    @Bindable var model: SettingsModel

    var body: some View {
        if let error = model.mcpLoadError {
            VStack(alignment: .leading, spacing: 4) {
                Text("Failed to Load Settings").textStyle(TextStyle(size: 13, weight: 600))
                Text(error).textStyle(TextStyle(size: 12.5))
            }
            .foregroundStyle(Palette.destructive)
        }
        if case .failed(let message) = model.mcpSave {
            SettingsErrorLine(text: message)
        }
        SettingsSection(heading: "Target Agent") {
            SettingsRow(title: "Target Agent", description: "Select which coding agent's MCP configuration to edit.", isFirst: true) {
                SegmentedField(options: AgentKind.allCases.map { ($0, $0.displayName) }, selection: model.mcpTarget) { agent in
                    Task { await model.selectMcpTarget(agent) }
                }
            }
        }
        statusSection
        configurationSection
    }

    private var statusSection: some View {
        let supported = McpStatus.isSupported(model.mcpTarget)
        // Before the first check there is nothing to report: the heading and its button stand alone.
        let hasContent = !supported || model.mcpStatusError != nil || model.mcpStatusLoading || model.mcpStatus != nil || model.mcpCheckedAt != nil
        return SettingsSection(heading: "MCP Server Connection Status", hasContent: hasContent) {
            GhostButton(title: model.mcpStatusLoading ? "Checking..." : "Check Connection",
                        isEnabled: supported && !model.mcpStatusLoading) {
                GhostGlyph(icon: .refreshCcw, busy: model.mcpStatusLoading)
            } action: {
                Task { await model.checkMcpStatus() }
            }
        } content: {
            if let error = model.mcpStatusError {
                SettingsCardLine { SettingsErrorLine(text: error) }
            }
            if !supported {
                SettingsCardLine {
                    Text("Connection checks are not available for \(model.mcpTarget.displayName).")
                        .textStyle(TextStyle(size: 13)).foregroundStyle(Palette.t300)
                }
            } else if model.mcpStatusLoading && model.mcpStatus == nil {
                SettingsCardLine { LoadingLine(text: "Checking...") }
            } else if let status = model.mcpStatus {
                if status.servers.isEmpty && model.mcpStatusError == nil {
                    SettingsCardLine {
                        Text("No MCP servers configured.").textStyle(TextStyle(size: 12)).foregroundStyle(Palette.t300)
                    }
                }
                ForEach(Array(status.servers.enumerated()), id: \.element.id) { index, server in
                    SettingsCardLine(isFirst: index == 0 && model.mcpStatusError == nil) {
                        Text(server.name).textStyle(TextStyle(size: 13, weight: 500)).foregroundStyle(Palette.fg)
                        Spacer(minLength: 8)
                        ConnectionBadge(connected: server.connected)
                    }
                }
            }
            if let checked = model.mcpCheckedAt {
                SettingsCardLine(isFirst: false) {
                    Text("Last checked: \(checked.formatted(date: .numeric, time: .standard))")
                        .textStyle(TextStyle(size: 11)).foregroundStyle(Palette.t300)
                }
            }
        }
    }

    private var configurationSection: some View {
        let file = model.mcpFile
        let fieldLabel = file?.isToml == true ? "Server Configuration (JSON view)" : "Server Configuration (JSON)"
        return SettingsSection(heading: "MCP Server Configuration") {
            VStack(alignment: .leading, spacing: 10) {
                if file?.isToml == true {
                    Text("Codex stores its configuration as TOML. The editor converts your changes automatically when saving.")
                        .textStyle(TextStyle(size: 12, lineHeight: 1.5)).foregroundStyle(Palette.t300)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // The path keeps a readable column; at large text the buttons go under it (as a settings row does).
                SettingsRowLayout {
                    VStack(alignment: .leading, spacing: 4) {
                        UppercaseLabel(text: "Changes will be saved to")
                        Text(file?.configPath ?? "").textStyle(.code(12)).foregroundStyle(Palette.fg)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 6) {
                        GhostButton(title: "Reload", bordered: true, isEnabled: !model.mcpLoading) {
                            GhostGlyph(icon: .refreshCcw, busy: model.mcpLoading)
                        } action: {
                            Task { await model.loadMcp() }
                        }
                        GhostButton(title: "Save", bordered: true,
                                    isEnabled: model.mcpDirty && model.mcpValidation == nil && !model.mcpLoading && model.mcpSave != .saving) {
                            GhostGlyph(icon: .save, busy: model.mcpSave == .saving)
                        } action: {
                            Task { await model.saveMcp() }
                        }
                    }
                    .fixedSize()
                }
                UppercaseLabel(text: fieldLabel)
                JSONEditorField(text: $model.mcpText, label: fieldLabel)
                    .disabled(model.mcpLoading || file == nil)
                if let problem = model.mcpValidation {
                    Text(problem).textStyle(TextStyle(size: 12)).foregroundStyle(Palette.destructive)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
        }
    }
}

/// The emerald "Connected" or grey "Disconnected" badge.
private struct ConnectionBadge: View {
    let connected: Bool

    var body: some View {
        Text(connected ? "Connected" : "Disconnected")
            .textStyle(TextStyle(size: 11, weight: 500))
            .foregroundStyle(connected ? Palette.emerald600 : Palette.t300)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Capsule().fill(connected ? Palette.emerald500.opacity(0.2) : Palette.muted))
            .overlay(Capsule().strokeBorder(connected ? Palette.emerald500.opacity(0.4) : Palette.t300.opacity(0.4)))
    }
}

/// `.jsonedit`: monospaced, no autocorrection, grows with its text.
private struct JSONEditorField: View {
    @Binding var text: String
    let label: String

    var body: some View {
        TextField("", text: $text, axis: .vertical)
            .textStyle(.code(12))
            .lineSpacing(12 * 0.6 - 2)
            .foregroundStyle(Palette.fg)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.asciiCapable)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 6).fill(Palette.bg90))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.border.opacity(0.9)))
            .accessibilityLabel(label)
    }
}
