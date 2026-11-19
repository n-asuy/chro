import ChroDomain
import ChroServices
import SwiftUI

/// Home and New session render the same body (the desktop's
/// SingleAgentSessionView with forceNewSession): the branch chip, the project
/// overview and the composer. Only the title differs.
struct ProjectLauncherScreen: View {
    enum Kind { case home, newSession }

    let projectID: String
    let kind: Kind
    /// New session here: the directory the composer starts mentioned.
    var homeDir: String? = nil
    @Environment(WorkspaceStore.self) private var store
    @Environment(ComposerDrafts.self) private var drafts
    @Environment(Router.self) private var router
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.externalScreens) private var external
    private static let edgeFade: CGFloat = 16

    var body: some View {
        let scratch = store.isScratch(projectID)
        let composer = drafts.model(projectID: projectID, isScratch: scratch, services: store.services)
        VStack(spacing: 0) {
            NavBar(title: kind == .home ? "Home" : "New session", onBack: { router.pop() }) {
                // A chat outside a project has no files or git to show (the mock omits its dock).
                if !scratch, let dock = external.dock {
                    IconButton(icon: .panelRight, size: 20, label: "Open right panel") {
                        sheets.present(tall: true) { dock(DockContext(projectID: projectID, sessionID: nil, panel: nil)) }
                    }
                }
            }
            if !scratch {
                HStack {
                    BranchChip(branch: "No branch", action: external.dock.map { dock in
                        { sheets.present(tall: true) { dock(DockContext(projectID: projectID, sessionID: nil, panel: .sourceControl)) } }
                    })
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 2)
            }
            ScrollView {
                ProjectOverview(projectID: projectID)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            // Rows fade out into the composer instead of being cut by its edge; the last row scrolls clear of the fade.
            .contentMargins(.bottom, Self.edgeFade, for: .scrollContent)
            .mask {
                VStack(spacing: 0) {
                    Color.black
                    LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .top, endPoint: .bottom).frame(height: Self.edgeFade)
                }
            }
            ComposerView(model: composer) { send(composer) }
        }
        .background(Palette.bg.ignoresSafeArea())
        .task {
            await composer.load()
            seedHomeDirectory(composer)
        }
    }

    /// single-agent-session.tsx: a new session opened for a directory starts
    /// with that directory mentioned, exactly like typing `@dir`, unless the
    /// draft already has content.
    private func seedHomeDirectory(_ composer: ComposerModel) {
        guard let homeDir, !homeDir.isEmpty, composer.isEmpty else { return }
        let name = homeDir.split(separator: "/").last.map(String.init) ?? homeDir
        composer.attach(ComposerReference(kind: .directory, label: "@\(name)", target: homeDir))
    }

    private func send(_ composer: ComposerModel) {
        Task {
            do {
                let prompt = composer.text.trimmingCharacters(in: .whitespacesAndNewlines)
                let runtime = composer.runtime
                let session = try await composer.send()
                SessionModels.shared.model(session.id, services: store.services).showStarted(prompt: prompt, runtime: runtime)
                store.noteOpened(session.id)
                router.reset(to: external.session != nil ? [.session(id: session.id)] : [])
            } catch {
                toasts.show("Failed to start session", description: (error as? ServiceError)?.message ?? error.localizedDescription)
            }
        }
    }
}

/// `.ov`: the project header (opens the switcher), Open actions and Recent sessions.
struct ProjectOverview: View {
    let projectID: String
    @Environment(WorkspaceStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(SheetPresenter.self) private var sheets
    @Environment(\.externalScreens) private var external

    var body: some View {
        let scratch = store.isScratch(projectID)
        let recent = store.sessions.filter { $0.projectID == projectID }.sorted { $0.updatedAt > $1.updatedAt }.prefix(8)
        VStack(alignment: .leading, spacing: 28) {
            Button { sheets.present { ProjectSwitcherSheet(currentProjectID: projectID) } } label: {
                HStack(spacing: 8) {
                    FolderGlyph().frame(width: 18, height: 18).opacity(0.7)
                    Text(scratch ? SessionListSection.chats.title : (store.project(projectID)?.name ?? ""))
                        .textStyle(.overviewTitle).lineLimit(1)
                    Icon(.chevronDown, size: 15).opacity(0.5)
                }
                .foregroundStyle(Palette.t300)
                .padding(4)
                .frame(minHeight: 44)
            }
            .buttonStyle(PressableStyle())
            .padding(.horizontal, -4)
            .accessibilityLabel("Switch project")

            VStack(alignment: .leading, spacing: 4) {
                OverviewCaption(text: "Open")
                QuickAction(icon: .plus, title: "New session") { router.push(.newSession(projectID: projectID)) }
                if let dock = external.dock {
                    QuickAction(icon: .search, title: "Search files…") {
                        sheets.present(tall: true) { dock(DockContext(projectID: projectID, sessionID: nil, panel: .searchFiles)) }
                    }
                }
                if external.panel != nil {
                    QuickAction(icon: .bookOpen, title: "Skills") { router.push(.panel(.skills(projectID: projectID))) }
                    QuickAction(icon: .images, title: "Gallery") { router.push(.panel(.gallery(projectID: projectID, sessionID: nil))) }
                }
            }

            if !recent.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    OverviewCaption(text: "Recent")
                    ForEach(Array(recent)) { session in
                        Button { open(session.id) } label: {
                            HStack(spacing: 10) {
                                AgentLogo(agent: session.agent, size: 18)
                                Text(session.title ?? "Untitled session").textStyle(.quickAction).lineLimit(1)
                                    .opacity(session.hasTitle ? 1 : 0.6)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Text(RelativeTime.format(session.updatedAt)).textStyle(.quickActionTime).opacity(0.5)
                            }
                            .foregroundStyle(Palette.t300)
                            .padding(.horizontal, 8)
                            .frame(minHeight: 44)
                        }
                        .buttonStyle(PressableStyle(pressedFill: Palette.muted))
                        .padding(.horizontal, -8)
                    }
                }
            }
        }
        .padding(.horizontal, 40)
        .padding(.top, 36)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func open(_ sessionID: String) {
        store.noteOpened(sessionID)
        if external.session != nil { router.push(.session(id: sessionID)) }
    }
}

private struct OverviewCaption: View {
    let text: String
    var body: some View {
        Text(text).textStyle(.overviewCaption).foregroundStyle(Palette.t300).opacity(0.6).padding(.bottom, 6)
    }
}

/// `.qa`
private struct QuickAction: View {
    let icon: LucideName
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Icon(icon, size: 18)
                Text(title).textStyle(.quickAction).lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Palette.t300)
            .padding(.horizontal, 8)
            .frame(minHeight: 44)
        }
        .buttonStyle(PressableStyle(pressedFill: Palette.muted))
        .padding(.horizontal, -8)
    }
}

/// components/folder-icon.tsx: the solid folder of the overview header.
struct FolderGlyph: View {
    var body: some View {
        Image("Brand/folder-solid").renderingMode(.template).resizable().foregroundStyle(Palette.t300)
    }
}

/// The overview header's switcher: Chats, then open projects, filtered.
struct ProjectSwitcherSheet: View {
    let currentProjectID: String
    @Environment(WorkspaceStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ToastCenter.self) private var toasts
    @State private var query = ""

    var body: some View {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let open = store.projects.openProjects.filter { !store.isScratch($0.id) }
        let list = open.filter { needle.isEmpty || $0.name.lowercased().contains(needle) || $0.path.lowercased().contains(needle) }
        VStack(spacing: 0) {
            // Titled by the switcher's trigger: the current project's name, or Chats.
            SheetHeader(title: store.isScratch(currentProjectID) ? SessionListSection.chats.title : store.projectName(currentProjectID) ?? "",
                        search: .init(placeholder: "Switch to project…", text: $query))
            SheetMenu {
                if !store.isScratch(currentProjectID) {
                    MenuItem(icon: .messageSquare, title: SessionListSection.chats.title) {
                        store.openScratchChat(toasts: toasts) { switchTo($0) }
                    }
                }
                ForEach(list) { project in
                    // The project's folder glyph (the overview header's) keeps every row on the Chats row's text edge.
                    SheetMenuRow(action: { switchTo(project.id) }) {
                        Icon(.folder, size: 18).foregroundStyle(Palette.t300)
                        TwoLineLabel(title: project.name, detail: project.path)
                    }
                }
                if list.isEmpty && store.isScratch(currentProjectID) {
                    SheetHint(text: open.isEmpty ? "No open projects" : "No matches")
                }
            }
        }
    }

    private func switchTo(_ projectID: String) {
        sheets.dismiss()
        switch router.top {
        case .newSession?: router.replaceTop(with: .newSession(projectID: projectID))
        default: router.replaceTop(with: .home(projectID: projectID))
        }
    }
}
