import ChroDomain
import ChroServices
import SwiftUI

/// Settings > Agents: default agent, agent CLIs, the chro CLI. pi credentials stay on the
/// desktop: the server refuses them to phones.
struct AgentsPane: View {
    @Bindable var model: SettingsModel
    @Environment(SheetPresenter.self) private var sheets

    /// The npm command the desktop's web build shows; registering the
    /// bundled command writes to the desktop computer and stays there.
    static let cliInstallCommand = "npm install -g @chro-ai/cli"

    var body: some View {
        SettingsSection(heading: "Default Agent") {
            SettingsRow(title: "Default Agent", description: "Choose which coding agent runs your tasks by default.", isFirst: true) {
                SettingsSelectButton(title: "Default Agent", value: model.defaultAgent?.displayName ?? "") {
                    SettingsOptions.present(sheets, model: model, pane: .agents, title: "Default Agent",
                                            groups: [SettingsOptionGroup(options: AgentKind.allCases.map { .init(id: $0.rawValue, label: $0.displayName) })],
                                            selected: model.defaultAgent?.rawValue) { id in
                        guard let agent = AgentKind(rawValue: id) else { return }
                        Task { await model.setDefaultAgent(agent) }
                    }
                }
                .disabled(model.defaultAgent == nil)
            }
        }
        cliSection
        SettingsSection(heading: "Chro CLI",
                        description: "Use `chro` from your terminal to create tasks, read logs, and merge runs. The command links to this app, so it updates with it.") {
            SettingsRow(title: "Shell command", isFirst: true) {
                EmptyView()
            } extra: {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Install the CLI from npm to drive tasks from your terminal:")
                        .textStyle(TextStyle(size: 12, lineHeight: 1.5)).foregroundStyle(Palette.t300)
                    CommandSnippet(command: Self.cliInstallCommand)
                }
            }
        }
    }

    private var cliSection: some View {
        SettingsSection(heading: "Agent CLIs") {
            GhostButton(title: "Refresh") {
                GhostGlyph(icon: .refreshCcw, busy: model.cliLoading)
            } action: {
                Task { await model.refreshCli() }
            }
        } content: {
            if model.cliError {
                SettingsCardLine { SettingsErrorLine(text: "Unable to read agent CLI status.") }
            }
            if model.cliStatus == nil && model.cliLoading {
                SettingsCardLine { LoadingLine(text: "Probing agent CLIs...") }
            }
            if let status = model.cliStatus {
                let rows = AgentKind.allCases.compactMap { kind in status.agents.first { AgentCliText.agent(forManifestName: $0.name) == kind } }
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, agent in
                    SettingsRow(title: AgentCliText.label(forManifestName: agent.name),
                                description: agent.found ? nil : agent.installHint, isFirst: index == 0 && !model.cliError) {
                        HStack(spacing: 6) {
                            Icon(agent.found ? .circleCheck : .circleX, size: 15)
                                .foregroundStyle(agent.found ? Palette.emerald500 : Palette.t300)
                            Text(AgentCliText.paneVersion(found: agent.found, version: agent.version))
                                .textStyle(TextStyle(size: 12, tabular: true))
                        }
                        .foregroundStyle(Palette.t300)
                    } extra: {
                        if agent.found, agent.path != nil || agent.source != nil {
                            VStack(alignment: .leading, spacing: 2) {
                                if let path = agent.path { KeyValueLine(key: "Path", value: path) }
                                if let source = agent.source { KeyValueLine(key: "Source", value: source) }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Palette.muted.opacity(0.2)))
                        }
                    }
                }
            }
        }
    }
}

/// `.kv` line: a muted key and its value.
private struct KeyValueLine: View {
    let key: String
    let value: String

    var body: some View {
        (Text("\(key): ").foregroundStyle(Palette.t300) + Text(value).foregroundStyle(Palette.fg))
            .textStyle(TextStyle(size: 12))
            .lineLimit(1)
            .truncationMode(.middle)
    }
}
