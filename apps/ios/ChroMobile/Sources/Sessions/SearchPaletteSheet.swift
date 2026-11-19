import ChroDomain
import ChroServices
import SwiftUI

/// "Where would you like to go?": the quick switcher (command-palette.tsx).
struct SearchPaletteSheet: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.externalScreens) private var external
    @State private var query = ""
    /// The host's matches for `query` (it holds sessions the phone does not).
    @State private var found: [SessionSummary] = []

    private static let newChat = PaletteCommand(id: "new-chat", label: "New chat")

    var body: some View {
        let selectable = store.projects.openProjects.filter { !store.isScratch($0.id) }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let sections = PaletteSections.build(
            query: query, commands: [Self.newChat], sessions: needle.isEmpty ? store.sessions : Self.merged(store.sessions, found), projects: selectable,
            projectNameOf: { store.projectName($0) }, lastViewedAtOf: { store.preferences.viewedAt[$0] }
        )
        VStack(spacing: 0) {
            // command-palette.tsx titles its dialog "Search" (for screen readers); the phone shows it.
            SheetHeader(title: "Search", search: .init(placeholder: "Where would you like to go?", text: $query))
            ScrollView {
                SheetMenu {
                    if sections.isEmpty {
                        SheetHint(text: "No matching destinations")
                    }
                    ForEach(Array(sections.enumerated()), id: \.element.id) { sectionIndex, section in
                        MenuLabel(text: section.id.title)
                        ForEach(Array(section.items.enumerated()), id: \.offset) { index, item in
                            row(item, highlighted: sectionIndex == 0 && index == 0)
                        }
                    }
                }
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .task(id: needle) {
            guard !needle.isEmpty else { return found = [] }
            // Settle on the typed text before asking the host.
            guard (try? await Task.sleep(for: .milliseconds(150))) != nil else { return }
            found = await store.searchSessions(needle)
        }
    }

    /// Held and found sessions, once each, newest first (the palette ranks them).
    static func merged(_ held: [SessionSummary], _ found: [SessionSummary]) -> [SessionSummary] {
        var byID: [String: SessionSummary] = [:]
        for session in found + held { byID[session.id] = session }
        return byID.values.sorted { $0.updatedAt > $1.updatedAt }
    }

    @ViewBuilder private func row(_ item: PaletteItem, highlighted: Bool) -> some View {
        switch item {
        case .command:
            MenuItem(icon: .squarePen, title: Self.newChat.label, isHighlighted: highlighted) {
                sheets.dismiss()
                store.openScratchChat(toasts: toasts) { router.push(.newSession(projectID: $0)) }
            }
        case .project(let id):
            SheetMenuRow(isHighlighted: highlighted, action: {
                sheets.dismiss()
                router.push(.home(projectID: id))
            }) {
                Icon(.folder, size: 16).foregroundStyle(Palette.t300).opacity(0.7)
                Text(store.project(id)?.name ?? id).lineLimit(1)
                Spacer(minLength: 0)
            }
        case .session(let session, _):
            SheetMenuRow(isHighlighted: highlighted, action: { open(session.id) }) {
                StatusMarkerGlyph(marker: store.marker(for: session)).frame(width: 18)
                (Text(session.displayTitle).foregroundStyle(Palette.fg)
                    + Text(" · \(store.projectName(session.projectID) ?? "")").foregroundStyle(Palette.t300))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Group {
                    if session.isRunning {
                        ActivityGlyph(awaitingInput: session.awaitingInput, size: 15)
                    } else {
                        Text(RelativeTime.format(session.updatedAt)).textStyle(TextStyle(size: 12.5, tabular: true))
                    }
                }
                .foregroundStyle(Palette.t300)
            }
        }
    }

    private func open(_ sessionID: String) {
        sheets.dismiss()
        store.noteOpened(sessionID)
        if external.session != nil { router.push(.session(id: sessionID)) }
    }
}
