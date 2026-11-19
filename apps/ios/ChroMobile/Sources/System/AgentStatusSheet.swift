import ChroDomain
import ChroServices
import SwiftUI
import UIKit

/// workspace-layout/components/agent-status-menu.tsx as a sheet: chro's
/// server and release, the agent skill, and each agent CLI with its usage over
/// the rolling window (loaded beside the status, never blocking it). Registering the
/// command and installing the skill write to the desktop computer, so the
/// phone shows the commands the desktop's web build shows.
struct AgentStatusSheet: View {
    static let releasesURL = URL(string: "https://github.com/n-asuy/chro/releases")!
    static let cliInstallCommand = "npm install -g @chro-ai/cli"
    static let skillInstallCommand = "chro skill install"

    @Environment(\.panelServices) private var services
    @Environment(SheetPresenter.self) private var presenter
    @State private var status: CliStatus?
    @State private var usage: [String: AgentUsage] = [:]
    @State private var probing = false
    @State private var copied: String?

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Agent status") {
                if probing {
                    Spinner(size: 16).foregroundStyle(Palette.t300).frame(width: 44, height: 44)
                } else {
                    IconButton(icon: .rotateCcw, size: 16, label: "Refresh") { refresh() }
                }
            }
            if let status {
                ScrollView {
                    VStack(spacing: 0) {
                        chroRow(status)
                        skillRow
                        ForEach(status.agents) { agent in agentRow(agent) }
                    }
                }
                .frame(maxHeight: 560)
                .fixedSize(horizontal: false, vertical: true)
                .scrollIndicators(.hidden)
            } else {
                SheetHint(text: probing ? "Probing CLIs…" : "No data.")
            }
        }
        .task { if status == nil { refresh() } }
    }

    private func refresh() {
        Task { await load() }
        Task { await loadUsage() }
    }

    private func load() async {
        probing = true
        defer { probing = false }
        // A probe failure leaves what was shown before.
        if let next = try? await services.system.cliStatus() { status = next }
    }

    /// Usage is auxiliary: a failure leaves the rows as they were.
    private func loadUsage() async {
        guard let reports = try? await services.system.agentUsage() else { return }
        usage = Dictionary(reports.map { ($0.provider, $0) }, uniquingKeysWith: { $1 })
    }

    private func chroRow(_ status: CliStatus) -> some View {
        StatusRow(isFirst: true) {
            Icon(status.updateAvailable ? .triangleAlert : .circleCheck, size: 17)
                .foregroundStyle(status.updateAvailable ? Palette.amber : Palette.emerald500)
        } title: {
            Text("chro")
            ExternalLinkGlyph(url: Self.releasesURL, label: "chro releases")
            Spacer(minLength: 8)
            Text("server \(status.serverVersion)").textStyle(TextStyle(size: 13, tabular: true)).foregroundStyle(Palette.t300)
        } meta: {
            MetaLine(key: "latest", value: status.latestRelease ?? "unknown")
            MetaText(text: "Install the chro CLI to drive tasks from your terminal:")
            copyable(Self.cliInstallCommand)
        }
    }

    private var skillRow: some View {
        StatusRow {
            // agent-status-menu.tsx SkillRow has no status icon; the column stays so the rows share one edge.
            Color.clear.accessibilityHidden(true)
        } title: {
            Text("Agent skill")
            Spacer(minLength: 8)
            Text("chro skill").textStyle(.code(13)).foregroundStyle(Palette.t300)
        } meta: {
            MetaText(text: "Teaches Claude Code and Codex to hand work to other sessions, wait for them, and answer their approvals through chro.", wraps: true)
            MetaText(text: "Run this in a terminal to install it:")
            CommandSnippet(command: Self.skillInstallCommand)
        }
    }

    private func agentRow(_ agent: CliStatus.Agent) -> some View {
        let label = AgentCliText.label(forManifestName: agent.name)
        return StatusRow {
            Icon(agent.found ? .circleCheck : .circleX, size: 17).foregroundStyle(agent.found ? Palette.emerald500 : Palette.t300)
        } title: {
            Text(label)
            if let kind = AgentCliText.agent(forManifestName: agent.name) {
                ExternalLinkGlyph(url: AgentInstallGuide.url(for: kind), label: "\(label) install guide")
            }
            Spacer(minLength: 8)
            Text(AgentCliText.version(found: agent.found, version: agent.version))
                .textStyle(TextStyle(size: 13, tabular: true)).foregroundStyle(Palette.t300).lineLimit(1)
        } meta: {
            if agent.found {
                if let path = agent.path { MetaLine(key: "path", value: path) }
                if let source = agent.source { MetaLine(key: "source", value: source) }
            } else {
                MetaText(text: agent.installHint, wraps: true)
            }
            if agent.found, let meter = UsageMeter(usage[agent.name]) { UsageMeterView(meter: meter) }
        }
    }

    private func copyable(_ command: String) -> some View {
        CommandSnippet(command: command, copied: copied == command) {
            UIPasteboard.general.string = command
            copied = command
            Task {
                try? await Task.sleep(for: .milliseconds(1500))
                if copied == command { copied = nil }
            }
        }
    }
}

/// `.asr`: a status row on one grid: the status icon column, then the title
/// line with its meta lines and command blocks under it, all on one left edge.
private struct StatusRow<Status: View, Title: View, Meta: View>: View {
    var isFirst = false
    @ViewBuilder var status: () -> Status
    @ViewBuilder var title: () -> Title
    @ViewBuilder var meta: () -> Meta

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            status().frame(width: 17, height: 20)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) { title() }
                    .textStyle(TextStyle(size: 15, weight: 500))
                    .foregroundStyle(Palette.fg)
                    .frame(minHeight: 20)
                meta()
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { if !isFirst { Rectangle().fill(Palette.muted).frame(height: 1) } }
    }
}

/// `UsageMeter`: the window, fresh against cached prompt tokens, the total, and the summary line.
private struct UsageMeterView: View {
    let meter: UsageMeter

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(meter.windowLabel).textStyle(TextStyle(size: 11.5)).foregroundStyle(Palette.t300)
                    .frame(width: 22, alignment: .leading)
                GeometryReader { proxy in
                    HStack(spacing: 0) {
                        Rectangle().fill(Palette.emerald500).frame(width: proxy.size.width * CGFloat(100 - meter.cachedPercent) / 100)
                        Rectangle().fill(Palette.fg.opacity(0.25))
                    }
                }
                .frame(height: 4)
                .background(Palette.muted)
                .clipShape(Capsule())
                .accessibilityHidden(true)
                Text(meter.total).textStyle(TextStyle(size: 11.5, tabular: true)).foregroundStyle(Palette.fg.opacity(0.8))
                    .frame(width: 60, alignment: .trailing)
            }
            // Read, not decoration: the tertiary text colour without a further fade.
            Text(meter.summary).textStyle(TextStyle(size: 12.5)).foregroundStyle(Palette.t300)
        }
        .padding(.top, 2)
    }
}

/// `.meta`: "key: value" with the value darker.
private struct MetaLine: View {
    let key: String
    let value: String

    var body: some View {
        (Text("\(key): ").foregroundStyle(Palette.t300) + Text(value).foregroundStyle(Palette.fg.opacity(0.8)))
            .textStyle(TextStyle(size: 12.5))
            .lineLimit(1)
            .truncationMode(.tail)
    }
}

private struct MetaText: View {
    let text: String
    var wraps = false

    var body: some View {
        Text(text).textStyle(TextStyle(size: 12.5)).foregroundStyle(Palette.t300)
            .lineLimit(wraps ? nil : 1)
            .fixedSize(horizontal: false, vertical: wraps)
    }
}

/// `.extl`: an external-link glyph with a 44pt target that does not widen the line.
private struct ExternalLinkGlyph: View {
    let url: URL
    let label: String
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button { openURL(url) } label: {
            Icon(.externalLink, size: 13).foregroundStyle(Palette.t300.opacity(0.6))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -12)
        .padding(.horizontal, -10)
        .accessibilityLabel(label)
    }
}
