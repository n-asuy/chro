import ChroDomain
import ChroServices
import SwiftUI

/// The dock's Agent panel (directory-agent-panel.tsx): the directory picked
/// in Files, its instructions file, the finished sessions addressed there,
/// and New session here.
struct AgentPanel: View {
    let context: DockContext
    @Environment(WorkspaceStore.self) private var store
    @Environment(SheetPresenter.self) private var sheets
    @Environment(Router.self) private var router
    @Environment(\.externalScreens) private var external
    @Environment(\.panelServices) private var services
    @State private var state = FilesDockState.shared
    @State private var info: DirectoryAgentInfo?

    private var target: String? { state.agentTargets[context.projectID] }
    private var navigator: FilesNavigator {
        FilesNavigator(context: context, sheets: sheets, router: router, external: external, services: services)
    }

    var body: some View {
        Group {
            if let target {
                ScrollView { content(target) }.scrollIndicators(.hidden)
            } else {
                SheetHint(text: "Select a directory in Files").padding(.top, 14)
                Spacer(minLength: 0)
            }
        }
        .task(id: target) { await load() }
    }

    private func content(_ target: String) -> some View {
        let project = store.project(context.projectID)
        let crumbs = DirectoryBrief.crumbs(projectName: project?.name ?? FileNaming.projectRootLabel, path: target)
        return VStack(alignment: .leading, spacing: 0) {
            Text(crumbs.joined(separator: " / "))
                .textStyle(.code(13))
                .foregroundStyle(Palette.t400)
                .lineLimit(2)
                .padding(6)
            caption("Instructions")
            if let brief = info?.brief {
                briefRow(brief, muted: false, title: brief)
            } else if let inherited = info?.inheritedBrief {
                briefRow(inherited, muted: true, title: "Inherits \(inherited)")
            } else {
                empty("No instructions file")
            }
            caption("History")
            if let ledger = info?.ledger, !ledger.isEmpty {
                ForEach(ledger) { entry in ledgerRow(entry) }
            } else {
                empty("No history yet")
            }
            Button { newSession() } label: {
                HStack(spacing: 10) {
                    Icon(.squarePen, size: 18)
                    Text("New session here").textStyle(TextStyle(size: 15))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Palette.t300)
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle(pressedForeground: Palette.fg))
            .disabled(project == nil)
            .opacity(project == nil ? 0.4 : 1)
            .padding(.top, 12)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
    }

    /// `.cap`
    private func caption(_ text: String) -> some View {
        Text(text).textStyle(TextStyle(size: 12, tracking: 0.05, uppercase: true)).foregroundStyle(Palette.t400)
            .padding(.horizontal, 6).frame(height: 28).padding(.top, 10)
    }

    /// `.emp`
    private func empty(_ text: String) -> some View {
        Text(text).textStyle(TextStyle(size: 14, weight: 500, tracking: 0.01)).foregroundStyle(Palette.t400)
            .padding(.horizontal, 10).padding(.vertical, 8)
    }

    private func briefRow(_ path: String, muted: Bool, title: String) -> some View {
        Button { navigator.openFile(path) } label: {
            HStack(spacing: 6) {
                Icon(.fileText, size: 15)
                Text(title).textStyle(TextStyle(size: 14)).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .foregroundStyle(muted ? Palette.t400 : Palette.t200)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(pressedForeground: Palette.fg))
    }

    /// `.row`: the outcome glyph, the title, and `Outcome · time · summary`.
    private func ledgerRow(_ entry: DirectoryAgentInfo.Entry) -> some View {
        Button { openSession(entry.sessionID) } label: {
            HStack(alignment: .top, spacing: 10) {
                OutcomeGlyph(outcome: entry.outcome).padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.title).textStyle(TextStyle(size: 15)).foregroundStyle(Palette.fg).lineLimit(1)
                    Text([entry.outcome.label, RelativeTime.format(entry.updatedAt), entry.summary].compactMap { $0 }.joined(separator: " · "))
                        .textStyle(TextStyle(size: 12.5)).foregroundStyle(Palette.t400).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        info = nil
        guard let target else { return }
        info = try? await services.files.directoryAgent(projectID: context.projectID, path: target)
    }

    private func openSession(_ sessionID: String) {
        guard external.session != nil else { return }
        sheets.dismiss()
        store.noteOpened(sessionID)
        router.push(.session(id: sessionID))
    }

    /// The shell's New session addressed to the picked directory (`newSession(project, target.path)`).
    private func newSession() {
        sheets.dismiss()
        router.push(.newSession(projectID: context.projectID, homeDir: target))
    }
}

/// The ledger's outcome glyph: merged and completed in emerald, failed red, archived grey.
private struct OutcomeGlyph: View {
    let outcome: LedgerOutcome

    var body: some View {
        switch outcome {
        case .merged: Icon(.gitMerge, size: 16).foregroundStyle(Palette.emerald600)
        case .completed: Icon(.check, size: 16).foregroundStyle(Palette.emerald600)
        case .failed: Icon(.x, size: 16).foregroundStyle(Palette.red500)
        case .archived: Icon(.archive, size: 16).foregroundStyle(Palette.t400)
        }
    }
}
