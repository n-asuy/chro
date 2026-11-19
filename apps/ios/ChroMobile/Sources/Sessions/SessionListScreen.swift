import ChroDomain
import ChroServices
import SwiftUI

/// The left panel as the app's root screen: title-bar tools, the list tools,
/// New chat, and the Pinned / Projects / Chats sections.
struct SessionListScreen: View {
    @Environment(WorkspaceStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.externalScreens) private var external

    var body: some View {
        VStack(spacing: 0) {
            titleBar
            listTools
            newChatButton
            TimelineView(.periodic(from: .now, by: 30)) { context in
                ScrollView {
                    SessionSections(now: context.date)
                        .padding(.horizontal, 8)
                        .padding(.bottom, 40)
                }
                .scrollIndicators(.hidden)
            }
        }
        .background(Palette.muted.ignoresSafeArea())
    }

    /// `.lp-top`: the desktop title bar's version chip and tools, right-aligned.
    @ViewBuilder private var titleBar: some View {
        let tools = [
            external.agentStatus.map { screen in (LucideName.terminal, "Agent status", screen) },
            external.feedback.map { screen in (LucideName.messageSquare, "Feedback", screen) },
            external.settings.map { screen in (LucideName.settings, "Settings", screen) },
        ].compactMap { $0 }
        if !tools.isEmpty || (external.panel != nil && external.appVersion != nil) {
            HStack(spacing: 0) {
                Spacer(minLength: 0)
                if external.panel != nil, let version = external.appVersion {
                    Button { router.push(.panel(.releaseNotes)) } label: {
                        Text(version).textStyle(.versionChip).foregroundStyle(Palette.t300)
                            .padding(.horizontal, 8).frame(height: 32).minimumHitArea()
                    }
                    .buttonStyle(PressableStyle())
                    .accessibilityLabel("Release notes")
                }
                ForEach(tools, id: \.1) { icon, label, screen in
                    IconButton(icon: icon, size: 18, label: label) { sheets.present(tall: label == "Settings") { screen() } }
                }
            }
            .padding(.horizontal, 6)
            .frame(height: 40)
        }
    }

    /// `.lp-head`: sort, collapse all, open another project, and search.
    private var listTools: some View {
        HStack(spacing: 0) {
            SortMenu()
            IconButton(icon: .chevronsDownUp, size: 20, label: "Collapse all") { store.toggleAllProjects() }
            IconButton(icon: .plus, size: 20, label: "Open another project") { sheets.present { OpenProjectSheet() } }
            Spacer(minLength: 0)
            IconButton(icon: .search, size: 20, label: "Search") { sheets.present(tall: true) { SearchPaletteSheet() } }
        }
        .padding(.horizontal, 6)
        .frame(height: 48)
    }

    /// `.newchat`: opens New session on the hidden General project.
    private var newChatButton: some View {
        Button {
            store.openScratchChat(toasts: toasts) { router.push(.newSession(projectID: $0)) }
        } label: {
            HStack(spacing: 12) {
                Icon(.squarePen, size: 19)
                Text("New chat").textStyle(.newChat)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(height: 48)
        }
        .buttonStyle(PressableStyle(pressedForeground: Palette.fg))
        .foregroundStyle(Palette.t300)
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
    }
}

/// The three sections, with the relation connector over them.
private struct SessionSections: View {
    let now: Date
    @Environment(WorkspaceStore.self) private var store

    var body: some View {
        let layout = store.layout
        let related = store.relatedSessionIDs
        VStack(alignment: .leading, spacing: 0) {
            if !layout.pinned.isEmpty {
                SectionHeader(section: .pinned, count: layout.count(of: .pinned))
                if !store.preferences.collapsedSections.contains(.pinned) {
                    VStack(spacing: 2) {
                        ForEach(layout.pinned) { row in SessionRow(row: row, basePadding: 10, inPinned: true, related: related, now: now) }
                    }
                    .padding(.top, 2)
                }
            }
            SectionHeader(section: .projects, count: layout.count(of: .projects))
            if !store.preferences.collapsedSections.contains(.projects) {
                VStack(spacing: 0) {
                    ForEach(layout.projects) { group in ProjectGroupView(group: group, related: related, now: now) }
                }
                .padding(.top, 2)
            }
            SectionHeader(section: .chats, count: layout.count(of: .chats))
            if !store.preferences.collapsedSections.contains(.chats) {
                Group {
                    if layout.chats.isEmpty {
                        EmptyListLine(leading: 12)
                    } else {
                        FoldableRows(key: "chats", projectIDs: store.projects.scratchProjectIDs.sorted(), rows: layout.chats, spacing: 2,
                                     basePadding: 10, related: related, now: now)
                    }
                }
                .padding(.top, 2)
            }
        }
        .overlayPreferenceValue(MarkerAnchorKey.self) { anchors in
            RelationConnector(anchors: anchors, order: visibleOrder(layout).filter(related.contains))
        }
    }

    private func visibleOrder(_ layout: SessionListLayout) -> [String] {
        layout.pinned.map(\.id) + layout.projects.flatMap { $0.rows.map(\.id) } + layout.chats.map(\.id)
    }
}

/// `.sec-h`: chevron, uppercase label, and the count while collapsed.
private struct SectionHeader: View {
    let section: SessionListSection
    let count: Int
    @Environment(WorkspaceStore.self) private var store

    var body: some View {
        let open = !store.preferences.collapsedSections.contains(section)
        Button { store.toggleSection(section) } label: {
            HStack(spacing: 6) {
                Icon(.chevronRight, size: 14).rotationEffect(.degrees(open ? 90 : 0))
                Text(section.title).textStyle(.sectionHeader)
                if !open && count > 0 {
                    Text("\(count)").textStyle(TextStyle(size: 12, weight: 500, tracking: 0.05, tabular: true))
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(Palette.t400)
            .padding(.horizontal, 8)
            .frame(height: 32)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(height: 32)
        .padding(.top, 10)
        .accessibilityLabel(section.title)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(open ? "Expanded" : "Collapsed, \(count)")
    }
}

/// `.proj` and its rows.
private struct ProjectGroupView: View {
    let group: SessionListLayout.ProjectGroup
    let related: Set<String>
    let now: Date
    @Environment(WorkspaceStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(SheetPresenter.self) private var sheets

    var body: some View {
        let open = !store.collapsedProjects.contains(group.project.id)
        VStack(spacing: 0) {
            RowButton(action: { router.push(.home(projectID: group.project.id)) }) { pressed in
                HStack(spacing: 6) {
                    Button { store.toggleProject(group.project.id) } label: {
                        Icon(.chevronRight, size: 16).rotationEffect(.degrees(open ? 90 : 0))
                            .foregroundStyle(Palette.t400)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(open ? "Collapse" : "Expand")
                    if let color = ProjectBadgeColor.resolve(group.project.badgeColor).flatMap(Color.init(hexString:)) {
                        Circle().fill(color).frame(width: 8, height: 8)
                    }
                    Text(group.project.name).textStyle(.projectName).foregroundStyle(Palette.t200).lineLimit(1, accessibility: 2)
                        // The row's full height is the name's hit area.
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(group.project.name)
                        .accessibilityAddTraits(.isButton)
                        .accessibilityHint(group.project.path)
                        .accessibilityAction { router.push(.home(projectID: group.project.id)) }
                    if store.hasArchived(group.project.id) {
                        IconButton(icon: .archive, size: 16, label: "Archive") {
                            sheets.present { ArchiveSheet(projectID: group.project.id) }
                        }
                    }
                    IconButton(icon: .plus, size: 16, label: "New chat") { router.push(.newSession(projectID: group.project.id)) }
                }
                .padding(.trailing, 4)
                .frame(minHeight: 44)
                .background(RoundedRectangle(cornerRadius: 6).fill(pressed ? Palette.pressed : .clear))
            }
            .rowContextMenuShape()
            .contextMenu { ProjectMenu(projectID: group.project.id) }
            if open {
                if group.rows.isEmpty {
                    EmptyListLine(leading: 20)
                } else {
                    FoldableRows(key: "project:\(group.project.id)", projectIDs: [group.project.id], rows: group.rows, spacing: 0, basePadding: 20,
                                 related: related, now: now)
                }
            }
        }
    }
}

/// A section's rows folded to the preview with "Show N more" (projects-panel FoldableSessionList).
/// Rows the host has not sent yet count as hidden; showing them asks for the next page.
private struct FoldableRows: View {
    let key: String
    /// The projects whose sessions the section lists.
    let projectIDs: [String]
    let rows: [SessionListRow]
    let spacing: CGFloat
    let basePadding: CGFloat
    let related: Set<String>
    let now: Date
    @Environment(WorkspaceStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @State private var loadingMore = false

    var body: some View {
        let unheld = store.unheld(in: projectIDs)
        let preview = SessionRows.preview(rows, isActive: { $0.id == store.focusedSessionID }, unheld: unheld)
        let unfolded = store.unfoldedGroups.contains(key)
        let folded = preview.hiddenCount > 0 && !unfolded
        // Unfolded with rows still on the host: offer those instead of folding.
        let more = folded ? preview.hiddenCount : unheld
        let shown = folded ? preview.visible : rows
        let faded = folded ? shown.last : nil
        VStack(spacing: spacing) {
            ForEach(shown) { row in
                SessionRow(row: row, basePadding: basePadding, inPinned: false, related: related, now: now)
                    .mask {
                        if let faded, faded.id == row.id, faded.id != store.focusedSessionID {
                            LinearGradient(colors: [.black.opacity(0.55), .black.opacity(0.2)], startPoint: .top, endPoint: .bottom)
                        } else {
                            Color.black
                        }
                    }
            }
            if preview.hiddenCount > 0 {
                Button { showMoreOrFewer(unheld: unheld, unfolded: unfolded) } label: {
                    HStack(spacing: 6) {
                        Icon(more > 0 ? .arrowDown : .arrowUp, size: 14).frame(width: 18)
                        Text(more > 0 ? "Show \(more) more" : "Show fewer").textStyle(.emptyList).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Palette.t400)
                    .padding(.leading, basePadding)
                    .frame(minHeight: 44)
                }
                .buttonStyle(PressableStyle(pressedForeground: Palette.t200))
                .disabled(loadingMore)
                .accessibilityValue(folded ? "Folded" : "Unfolded")
            }
        }
    }

    private func showMoreOrFewer(unheld: Int, unfolded: Bool) {
        guard unheld > 0 else {
            store.toggleUnfolded(key)
            return
        }
        if !unfolded { store.toggleUnfolded(key) }
        loadingMore = true
        Task {
            defer { loadingMore = false }
            do { try await store.showMore(in: projectIDs) } catch {
                toasts.show("Failed to load sessions", description: (error as? ServiceError)?.message ?? error.localizedDescription)
            }
        }
    }
}

/// One session row wired to the store, the router and the row menu.
private struct SessionRow: View {
    let row: SessionListRow
    let basePadding: CGFloat
    let inPinned: Bool
    let related: Set<String>
    let now: Date
    @Environment(WorkspaceStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.externalScreens) private var external

    var body: some View {
        SessionRowView(
            row: row, basePadding: basePadding, marker: store.marker(for: row.session), subline: store.subline(for: row, inPinned: inPinned),
            isFocused: store.focusedSessionID == row.id, isRelated: related.contains(row.id), now: now,
            onToggleDelegation: inPinned ? nil : { store.toggleDelegation(row.id) },
            onOpen: { open() }
        )
        .rowContextMenuShape()
        .contextMenu { SessionRowMenu(sessionID: row.id) }
    }

    private func open() {
        store.noteOpened(row.id)
        if external.session != nil { router.push(.session(id: row.id)) }
    }
}

/// `.empty-l`
private struct EmptyListLine: View {
    let leading: CGFloat

    var body: some View {
        Text("No chats")
            .textStyle(.emptyList)
            .foregroundStyle(Palette.t400)
            .padding(.vertical, 8)
            .padding(.leading, leading)
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
