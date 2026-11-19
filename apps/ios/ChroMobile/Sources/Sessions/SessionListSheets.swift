import ChroDomain
import ChroServices
import SwiftUI

/// A session row's context menu (projects-panel row menu): Pin, Continue in…, Archive.
struct SessionRowMenu: View {
    let sessionID: String
    @Environment(WorkspaceStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.externalScreens) private var external

    var body: some View {
        if let session = store.session(sessionID) {
            let pinned = store.isPinned(sessionID)
            Button { store.togglePin(sessionID) } label: { Label(pinned ? "Unpin" : "Pin", lucide: pinned ? .pinOff : .pin) }
            if store.isScratch(session.projectID) {
                Button { continueSession(.sameCheckout) } label: { Label("Continue in new session", lucide: .gitBranch) }
            } else {
                Menu {
                    Button("Continue in new session") { continueSession(.sameCheckout) }
                    Button("Continue in new worktree") { continueSession(.newWorktree) }
                } label: {
                    Label("Continue in…", lucide: .gitBranch)
                }
            }
            Divider()
            Button {
                Task {
                    do { try await store.archive(sessionID) } catch { toasts.show("Failed to archive session", description: error.localizedDescription) }
                }
            } label: {
                Label("Archive", lucide: .archive)
            }
        }
    }

    private func continueSession(_ checkout: ContinuationCheckout) {
        Task {
            do {
                let fork = try await store.services.sessions.continueSession(sessionID: sessionID, in: checkout)
                store.noteOpened(fork.id)
                if external.session != nil { router.push(.session(id: fork.id)) }
            } catch let error as ServiceError {
                toasts.show(error.message)
            } catch {
                toasts.show("Could not continue in a new session")
            }
        }
    }
}

/// The list's sort control: the desktop's titled dropdown, as a system menu
/// with the current order checked.
struct SortMenu: View {
    @Environment(WorkspaceStore.self) private var store

    var body: some View {
        Menu {
            Section("Sort") {
                ForEach(SessionSortMode.allCases, id: \.self) { mode in
                    Toggle(mode.label, isOn: Binding(get: { store.preferences.sortMode == mode }, set: { if $0 { store.setSortMode(mode) } }))
                }
            }
        } label: {
            Icon(.arrowDownUp, size: 20).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .foregroundStyle(Palette.t300)
        .accessibilityLabel("Sort")
        .accessibilityShowsLargeContentViewer { Icon(.arrowDownUp, size: 20); Text("Sort") }
    }
}

/// "Open another project": up to five recent projects, then New workspace.
struct OpenProjectSheet: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ToastCenter.self) private var toasts
    @State private var pending: String?

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Open another project")
            SheetMenu {
                if store.projects.recents.isEmpty {
                    Text("No recent projects").textStyle(TextStyle(size: 13)).foregroundStyle(Palette.t300)
                        .padding(.horizontal, 10).frame(minHeight: 48)
                } else {
                    ForEach(store.projects.recents.prefix(5)) { project in
                        SheetMenuRow(isEnabled: pending == nil, action: { open(project) }) {
                            if pending == project.id { Spinner(size: 15).foregroundStyle(Palette.t300) }
                            TwoLineLabel(title: project.name, detail: project.path)
                        }
                    }
                }
                MenuSeparator()
                MenuItem(icon: .plus, title: "New workspace") {
                    sheets.dismiss()
                    router.push(.folderPicker(.openProject))
                }
            }
        }
    }

    private func open(_ project: ProjectSummary) {
        pending = project.id
        Task {
            do {
                let opened = try await store.services.projects.openWorkspace(path: project.path)
                sheets.dismiss()
                router.reset(to: [.home(projectID: opened.id)])
            } catch {
                pending = nil
                toasts.show("Failed to open project", description: (error as? ServiceError)?.message ?? error.localizedDescription)
            }
        }
    }
}

/// `.mi .two`: a primary line over a small secondary one.
struct TwoLineLabel: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).textStyle(.menuItem).foregroundStyle(Palette.fg).lineLimit(1)
            Text(detail).textStyle(.menuDetail).foregroundStyle(Palette.t300).lineLimit(1).truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A project's archived sessions, searchable, each with Restore. The host
/// searches and sends them a page at a time; the next page loads at the end.
struct ArchiveSheet: View {
    let projectID: String
    @Environment(WorkspaceStore.self) private var store
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ToastCenter.self) private var toasts
    @State private var query = ""
    @State private var archived: [ArchivedSession] = []
    @State private var total = 0

    var body: some View {
        let needle = query.trimmingCharacters(in: .whitespaces)
        let shown = archived
        VStack(spacing: 0) {
            SheetHeader(title: "Archive")
            SheetSearchField(placeholder: "Search...", text: $query)
                .padding(.horizontal, 10).padding(.top, 4).padding(.bottom, 6)
            ScrollView {
                SheetMenu {
                    if shown.isEmpty {
                        VStack(spacing: 8) {
                            Icon(.archive, size: 24).foregroundStyle(Palette.t300).opacity(0.4)
                            Text("No archived sessions").textStyle(.hint).foregroundStyle(Palette.t300)
                        }
                        .padding(.vertical, 14).frame(maxWidth: .infinity)
                    } else {
                        ForEach(shown) { entry in
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 0) {
                                    Text(entry.session.title ?? "Untitled").textStyle(.menuItem).foregroundStyle(Palette.fg).lineLimit(1)
                                    Text(entry.session.shortID).textStyle(.code(12)).foregroundStyle(Palette.t300)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                Text(RelativeTime.format(entry.archivedAt)).textStyle(.menuDetail).foregroundStyle(Palette.t300)
                                IconButton(icon: .rotateCcw, size: 15, label: "Restore session") { restore(entry.id) }
                            }
                            .padding(.leading, 10)
                            .frame(minHeight: 48)
                            .onAppear { if entry.id == shown.last?.id { loadNextPage(needle) } }
                        }
                    }
                }
            }
            .frame(maxHeight: 420)
            .fixedSize(horizontal: false, vertical: true)
        }
        .task(id: needle) {
            if !needle.isEmpty {
                // Settle on the typed text before asking the host.
                guard (try? await Task.sleep(for: .milliseconds(150))) != nil else { return }
            }
            await load(needle)
        }
    }

    private func load(_ needle: String) async {
        guard let page = try? await store.services.sessions.archivedSessions(projectID: projectID, matching: needle, offset: 0) else { return }
        archived = page.sessions
        total = page.total
    }

    private func loadNextPage(_ needle: String) {
        guard archived.count < total else { return }
        let offset = archived.count
        Task {
            guard let page = try? await store.services.sessions.archivedSessions(projectID: projectID, matching: needle, offset: offset),
                  archived.count == offset
            else { return }
            archived += page.sessions
            total = page.total
        }
    }

    private func restore(_ id: String) {
        Task {
            do {
                try await store.services.sessions.restore(sessionID: id)
                await load(query.trimmingCharacters(in: .whitespaces))
                if archived.isEmpty { sheets.dismiss() }
            } catch {
                toasts.show("Failed to restore session", description: error.localizedDescription)
            }
        }
    }
}

/// A project header's context menu: Color and Remove from Sidebar.
struct ProjectMenu: View {
    let projectID: String
    @Environment(WorkspaceStore.self) private var store
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ToastCenter.self) private var toasts

    var body: some View {
        Button { sheets.present { ProjectColorSheet(projectID: projectID) } } label: { Label("Color", lucide: .circle) }
        Divider()
        Button {
            Task {
                do { try await store.services.projects.removeFromSidebar(projectID: projectID) } catch {
                    toasts.show("Failed to remove project", description: error.localizedDescription)
                }
            }
        } label: {
            Label("Remove from Sidebar", lucide: .x)
        }
    }
}

/// `.pdot`: a project's badge colour, hollow when it has none.
struct ProjectDot: View {
    let color: String?

    var body: some View {
        if let resolved = ProjectBadgeColor.resolve(color).flatMap(Color.init(hexString:)) {
            Circle().fill(resolved).frame(width: 7, height: 7)
        } else {
            Circle().strokeBorder(Palette.t400, lineWidth: 1).frame(width: 7, height: 7)
        }
    }
}

/// project-color-picker.tsx: presets, a hue/value field, saturation and Clear color.
struct ProjectColorSheet: View {
    let projectID: String
    @Environment(WorkspaceStore.self) private var store
    @Environment(SheetPresenter.self) private var sheets
    @State private var saturation = ProjectColorPicker.defaultSaturation
    @State private var marker: CGPoint?

    var body: some View {
        let current = store.project(projectID)?.badgeColor
        let isCustom = current?.hasPrefix("#") == true
        VStack(spacing: 0) {
            SheetHeader(title: "Color")
            HStack(spacing: 0) {
                ForEach(ProjectBadgeColor.allCases, id: \.self) { preset in
                    Button { set(preset.rawValue) } label: {
                        Circle().fill(Color(hexString: preset.hex)!).frame(width: 24, height: 24)
                            .overlay {
                                if current == preset.rawValue {
                                    Circle().strokeBorder(Palette.bg, lineWidth: 2).padding(-2)
                                    Circle().strokeBorder(Palette.t200, lineWidth: 2).padding(-4)
                                }
                            }
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(preset.label)
                    .accessibilityAddTraits(current == preset.rawValue ? .isSelected : [])
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            GeometryReader { proxy in
                ZStack(alignment: .topLeading) {
                    LinearGradient(colors: [0xD94A44, 0xD9A13C, 0xCFD23C, 0x58C04F, 0x3FC0AE, 0x4478D9, 0x8A4FD0, 0xCF4FB4, 0xD94A44].map { Color(hex: $0) },
                                   startPoint: .leading, endPoint: .trailing)
                    LinearGradient(stops: [.init(color: .white.opacity(0.85), location: 0), .init(color: .white.opacity(0), location: 0.4),
                                           .init(color: .black.opacity(0), location: 0.6), .init(color: .black.opacity(0.7), location: 1)],
                                   startPoint: .top, endPoint: .bottom)
                    if isCustom, let marker, let current, let color = Color(hexString: current) {
                        Circle().fill(color).frame(width: 18, height: 18)
                            .overlay(Circle().strokeBorder(.white, lineWidth: 2))
                            .shadow(color: .black.opacity(0.3), radius: 1, y: 1)
                            .position(x: marker.x * proxy.size.width, y: marker.y * proxy.size.height)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                    let point = CGPoint(x: min(1, max(0, value.location.x / proxy.size.width)), y: min(1, max(0, value.location.y / proxy.size.height)))
                    marker = point
                    set(ProjectColorPicker.hex(x: point.x, y: point.y, saturation: saturation))
                })
                .accessibilityLabel("Custom color")
            }
            .frame(height: 120)
            .padding(.horizontal, 16).padding(.vertical, 6)
            HStack(spacing: 12) {
                Text("Saturation")
                Slider(value: $saturation, in: 10...100).tint(Palette.primary)
                    .onChange(of: saturation) { _, value in
                        if isCustom, let marker { set(ProjectColorPicker.hex(x: marker.x, y: marker.y, saturation: value)) }
                    }
            }
            .textStyle(TextStyle(size: 13)).foregroundStyle(Palette.t300)
            .padding(.horizontal, 16).padding(.vertical, 8)
            HStack(spacing: 8) {
                Button("Clear color") { set(nil) }
                    .buttonStyle(.plain).disabled(current == nil).opacity(current == nil ? 0.5 : 1).minimumHitArea()
                Spacer(minLength: 0)
                if current != nil { ProjectDot(color: current) }
                if isCustom, let current { Text(current) }
            }
            .textStyle(TextStyle(size: 13)).foregroundStyle(Palette.t300)
            .padding(.top, 6)
            .overlay(alignment: .top) { Rectangle().fill(Palette.muted).frame(height: 1) }
            .padding(.horizontal, 16).padding(.top, 8)
        }
    }

    private func set(_ color: String?) {
        Task { try? await store.services.projects.setBadgeColor(projectID: projectID, color: color) }
    }
}
