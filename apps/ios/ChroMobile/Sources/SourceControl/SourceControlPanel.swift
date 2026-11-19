import ChroDomain
import ChroServices
import SwiftUI

/// The dock's Source Control panel (source-control-panel.tsx): toolbar,
/// All changes / Uncommitted, branch → target, the change lists, and in a
/// session worktree the Rebase onto / Merge into buttons.
struct SourceControlPanel: View {
    let context: DockContext
    @Environment(WorkspaceStore.self) private var store
    @Environment(\.panelServices) private var services
    @State private var model: SourceControlModel?

    var body: some View {
        let scope = context.checkoutScope(in: store)
        Group {
            if let model, model.checkout == scope {
                SourceControlContent(model: model, projectID: context.projectID)
            } else {
                Color.clear
            }
        }
        .task(id: scope) {
            let model = SourceControlModel(checkout: scope, service: services.sourceControl)
            self.model = model
            await model.run()
        }
    }
}

private struct SourceControlContent: View {
    @Bindable var model: SourceControlModel
    let projectID: String
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ToastCenter.self) private var toasts
    @Environment(Router.self) private var router
    @FocusState private var messageFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            HStack {
                ScopePicker(selection: $model.scope)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.top, 2)
            branchLine
            if model.scope == .uncommitted { commitMessage }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if model.scope == .all { allChanges } else { uncommittedChanges }
                }
                .padding(.horizontal, 8)
            }
            .scrollIndicators(.hidden)
            if model.checkout.isRun { integration }
        }
        .onAppear {
            model.onFailure = { [toasts] in toasts.show($0) }
            model.onNotice = { [toasts] in toasts.show($0) }
        }
    }

    // MARK: Toolbar (`.sc-tool`)

    private var toolbar: some View {
        HStack(spacing: 0) {
            ToolButton(icon: .fileDiff, label: "View All Changes", isEnabled: model.canViewAllChanges && model.sessionID != nil) { openDiff(nil) }
            if model.scope == .uncommitted {
                ToolButton(icon: .check, label: "Commit", isEnabled: !model.isLoading && !model.isCommitting && model.canCommit) {
                    Task { await model.commit() }
                }
                ToolButton(icon: .plus, label: "Stage All", isEnabled: !model.isLoading && model.changesCount > 0) { Task { await model.stageAll() } }
                ToolButton(icon: .minus, label: "Unstage All", isEnabled: !model.isLoading && model.stagedCount > 0) { Task { await model.unstageAll() } }
            }
            ToolButton(icon: .upload, label: "Push (\(model.pushCount))", count: model.pushCount, isEnabled: !model.isLoading) { Task { await model.push() } }
            ToolButton(icon: .download, label: "Pull (\(model.pullCount))", count: model.pullCount, isEnabled: !model.isLoading) { Task { await model.pull() } }
            ToolButton(icon: .refreshCw, label: "Refresh", isEnabled: !model.isLoading, spins: model.isLoading) { Task { await model.reload() } }
            Spacer(minLength: 0)
            let tree = model.viewMode == .tree
            ToolButton(icon: tree ? .listTree : .list, label: tree ? "View as List" : "View as Tree", isEnabled: true) {
                model.viewMode = tree ? .list : .tree
            }
            .accessibilityAddTraits(tree ? .isSelected : [])
        }
        .padding(.horizontal, 6)
        .frame(height: 48)
    }

    // MARK: Branch (`.sc-branch`)

    private var branchLine: some View {
        HStack(spacing: 8) {
            Icon(.gitBranch, size: 15).foregroundStyle(Palette.t300)
            Text(model.status?.currentBranch ?? "No branch").foregroundStyle(Palette.t200).lineLimit(1).truncationMode(.tail)
            if model.scope == .all, let base = model.baseRef {
                Text("→").foregroundStyle(Palette.t300).fixedSize()
                Text(base).foregroundStyle(Palette.t200).lineLimit(1).fixedSize()
            }
            Spacer(minLength: 0)
        }
        .textStyle(TextStyle(size: 15))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    // MARK: Commit message (`.commitmsg`)

    private var commitMessage: some View {
        TextField("", text: $model.commitMessage, prompt: Text("Commit message (Ctrl+Enter to commit)").foregroundStyle(Palette.t300), axis: .vertical)
            .lineLimit(2, reservesSpace: true)
            .textStyle(TextStyle(size: 15))
            .foregroundStyle(Palette.fg)
            .focused($messageFocused)
            .onChange(of: messageFocused) { _, focused in if focused { model.refreshDefaultMessage() } }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Palette.bg80)
            .accessibilityLabel("Commit message")
    }

    // MARK: Lists

    @ViewBuilder private var allChanges: some View {
        SectionHeader(title: "Changes", count: model.changes.count, isCollapsed: model.collapsedSections.contains("changes")) {
            model.collapsedSections.formSymmetricDifference(["changes"])
        }
        if !model.collapsedSections.contains("changes") {
            ChangeRows(model: model, entries: model.changes.map { ($0.path, GitFileStatus($0.kind), false) }, isStaged: false, open: openRow, openFile: openFile)
            if model.changes.isEmpty, let base = model.baseRef {
                Text("Up to date with \(base)")
                    .textStyle(TextStyle(size: 13)).foregroundStyle(Palette.t300)
                    .frame(maxWidth: .infinity).padding(.vertical, 16).padding(.horizontal, 8)
            }
        }
    }

    @ViewBuilder private var uncommittedChanges: some View {
        SectionHeader(title: "Staged Changes", count: model.stagedCount, isCollapsed: model.collapsedSections.contains("staged"),
                      toggle: { model.collapsedSections.formSymmetricDifference(["staged"]) }) {
            if model.stagedCount > 0 {
                SectionAction(icon: .minus, label: "Unstage all") { Task { await model.unstageAll() } }
            }
        }
        if !model.collapsedSections.contains("staged") {
            ChangeRows(model: model, entries: (model.status?.staged ?? []).map { ($0.path, $0.status, false) }, isStaged: true, open: openRow, openFile: openFile)
        }
        SectionHeader(title: "Changes", count: model.changesCount, isCollapsed: model.collapsedSections.contains("changes"),
                      toggle: { model.collapsedSections.formSymmetricDifference(["changes"]) }) {
            if model.changesCount > 0 {
                SectionAction(icon: .undo2, label: "Discard all") { Task { await model.discardAll() } }
                SectionAction(icon: .plus, label: "Stage all") { Task { await model.stageAll() } }
            }
        }
        if !model.collapsedSections.contains("changes") {
            ChangeRows(model: model,
                       entries: (model.status?.modified ?? []).map { ($0.path, $0.status, false) } + (model.status?.untracked ?? []).map { ($0, .added, true) },
                       isStaged: false, open: openRow, openFile: openFile)
        }
    }

    // MARK: Integration (`.sc-int`)

    private var integration: some View {
        let state = model.integration
        return VStack(spacing: 8) {
            if let notice = state.blockedNotice {
                Text(notice)
                    .textStyle(TextStyle(size: 13, lineHeight: 1.4))
                    .foregroundStyle(Palette.amber700)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Palette.amber.opacity(0.1)))
            }
            IntegrationButton(title: state.rebaseLabel, badge: state.rebaseBadge, hint: state.rebaseHint, kind: .rebase,
                              isEnabled: state.canRebase, isBusy: model.isRebasing) { Task { await model.rebase() } }
            IntegrationButton(title: state.mergeLabel, badge: state.mergeBadge, hint: state.mergeHint, kind: .merge,
                              isEnabled: state.canMerge, isBusy: model.isMerging) { Task { await model.merge() } }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
    }

    // MARK: Navigation

    /// A run's change opens its diff; the main checkout has no diff screen to open, so its rows open the file.
    private func openRow(_ path: String) {
        if model.sessionID != nil { openDiff(path) } else { openFile(path) }
    }

    private func openDiff(_ path: String?) {
        guard let sessionID = model.sessionID else { return }
        sheets.dismiss()
        router.push(.panel(.diff(sessionID: sessionID, path: path)))
    }

    private func openFile(_ path: String) {
        sheets.dismiss()
        router.push(.panel(.file(FileLocation(projectID: projectID, sessionID: model.sessionID, path: path))))
    }
}

/// `.scope`: All changes / Uncommitted.
private struct ScopePicker: View {
    @Binding var selection: SourceControlModel.Scope

    var body: some View {
        ScopeSwitch(selection: $selection, options: [(.all, "All changes"), (.uncommitted, "Uncommitted")])
    }
}

/// `.ib` with an optional count, as the toolbar draws Push and Pull.
private struct ToolButton: View {
    let icon: LucideName
    let label: String
    var count: Int?
    let isEnabled: Bool
    var spins = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3) {
                if spins { SpinningIcon(name: icon) } else { Icon(icon, size: 18) }
                if let count { Text("\(count)").textStyle(TextStyle(size: 11, tabular: true)) }
            }
            .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(PressableStyle(pressedForeground: Palette.fg))
        .foregroundStyle(Palette.t300)
        .opacity(isEnabled ? 1 : 0.4)
        .disabled(!isEnabled)
        .accessibilityLabel(label)
    }
}

private struct SpinningIcon: View {
    let name: LucideName
    @State private var spinning = false

    var body: some View {
        Icon(name, size: 18)
            .rotationEffect(.degrees(spinning ? 360 : 0))
            .animation(.linear(duration: 1).repeatForever(autoreverses: false), value: spinning)
            .onAppear { spinning = true }
    }
}

/// `.csec`: a collapsible section title with its count and actions.
private struct SectionHeader<Actions: View>: View {
    let title: String
    let count: Int
    let isCollapsed: Bool
    let toggle: () -> Void
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        HStack(spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 4) {
                    Icon(isCollapsed ? .chevronRight : .chevronDown, size: 15)
                    Text("\(title) (\(count))")
                    Spacer(minLength: 0)
                }
                .textStyle(TextStyle(size: 13, weight: 500))
                .foregroundStyle(Palette.t200)
                .padding(.horizontal, 8)
                .frame(height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle(cornerRadius: 4))
            .accessibilityValue(isCollapsed ? "Collapsed" : "Expanded")
            actions()
        }
    }
}

extension SectionHeader where Actions == EmptyView {
    init(title: String, count: Int, isCollapsed: Bool, toggle: @escaping () -> Void) {
        self.init(title: title, count: count, isCollapsed: isCollapsed, toggle: toggle, actions: { EmptyView() })
    }
}

private struct SectionAction: View {
    let icon: LucideName
    let label: String
    let action: () -> Void

    var body: some View {
        IconButton(icon: icon, size: 15, label: label, tint: Palette.t200, action: action)
    }
}

/// The change list in list or tree form (change-file-list.tsx), paged 300 at a time.
private struct ChangeRows: View {
    @Bindable var model: SourceControlModel
    let entries: [(path: String, status: GitFileStatus, untracked: Bool)]
    let isStaged: Bool
    let open: (String) -> Void
    let openFile: (String) -> Void
    @State private var pages = 1

    var body: some View {
        let visible = ChangeFileTree.visibleCount(total: entries.count, pages: pages)
        let shown = Array(entries.prefix(visible))
        let byPath = Dictionary(shown.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
        ForEach(ChangeFileTree.rows(paths: shown.map(\.path), mode: model.viewMode, collapsed: model.collapsedFolders)) { row in
            switch row {
            case .directory(let key, let name, let depth, let isCollapsed):
                Button { model.collapsedFolders.formSymmetricDifference([key]) } label: {
                    HStack(spacing: 6) {
                        Icon(isCollapsed ? .chevronRight : .chevronDown, size: 15).foregroundStyle(Palette.t300)
                        Icon(.folder, size: 15).foregroundStyle(Palette.t300)
                        Text(name).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 0)
                    }
                    .textStyle(TextStyle(size: 15))
                    .foregroundStyle(Palette.t200)
                    .padding(.leading, 8 + CGFloat(depth) * 12)
                    .padding(.trailing, 8)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle(cornerRadius: 4, pressedFill: Palette.bg80))
                .accessibilityValue(isCollapsed ? "Collapsed" : "Expanded")
            case .file(let path, let depth):
                if let entry = byPath[path] {
                    ChangeRow(model: model, path: path, status: entry.status, isUntracked: entry.untracked, isStaged: isStaged, depth: depth,
                              open: { open(path) }, openFile: { openFile(path) })
                }
            }
        }
        if let more = ChangeFileTree.moreLabel(total: entries.count, visible: visible) {
            Button { pages += 1 } label: {
                Text(more).textStyle(TextStyle(size: 12)).foregroundStyle(Palette.t300)
                    .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle(cornerRadius: 4, pressedFill: Palette.bg80))
        }
    }
}

/// `.frow`: one changed file. The desktop's hover actions (open, discard,
/// stage, unstage) are the row's long-press menu.
private struct ChangeRow: View {
    let model: SourceControlModel
    let path: String
    let status: GitFileStatus
    let isUntracked: Bool
    let isStaged: Bool
    let depth: Int
    let open: () -> Void
    let openFile: () -> Void

    var body: some View {
        let counts = model.counts(path)
        Button(action: open) {
            HStack(spacing: 10) {
                StatusGlyph(status: status, isUntracked: isUntracked)
                Text(ChangeFileTree.fileName(path)).foregroundStyle(Palette.fg).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                if counts.additions > 0 {
                    Text("+\(counts.additions)").textStyle(TextStyle(size: 12, weight: 500, tabular: true)).foregroundStyle(Palette.emerald500)
                }
                if counts.deletions > 0 {
                    Text("-\(counts.deletions)").textStyle(TextStyle(size: 12, weight: 500, tabular: true)).foregroundStyle(Palette.rose500)
                }
                let letter = StatusGlyph.letter(status: status, isUntracked: isUntracked)
                Text(letter.text).textStyle(TextStyle(size: 13, weight: 500)).foregroundStyle(letter.color).frame(width: 18)
            }
            .textStyle(TextStyle(size: 15))
            .padding(.leading, 8 + CGFloat(depth) * 12)
            .padding(.trailing, 8)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(cornerRadius: 4, pressedFill: Palette.bg80))
        .accessibilityLabel(path)
        .contextMenu {
            if status != .deleted {
                Button("Open file", systemImage: "arrow.up.forward.square", action: openFile)
            }
            if model.scope == .uncommitted {
                if isStaged {
                    Button("Unstage file", systemImage: "minus") { Task { await model.unstage([path]) } }
                } else {
                    if !isUntracked {
                        Button("Discard changes", systemImage: "arrow.uturn.backward", role: .destructive) { Task { await model.discard([path]) } }
                    }
                    Button("Stage file", systemImage: "plus") { Task { await model.stage([path]) } }
                }
            }
        }
    }
}

/// The status icon of a changed file (getStatusIcon).
private struct StatusGlyph: View {
    let status: GitFileStatus
    let isUntracked: Bool

    static let green = Color(hex: 0x22C55E), yellow = Color(hex: 0xEAB308), blue = Color(hex: 0x3B82F6)

    var body: some View {
        if isUntracked {
            Icon(.filePlus, size: 18).foregroundStyle(Self.green)
        } else {
            switch status {
            case .added: Icon(.filePlus, size: 18).foregroundStyle(Self.green)
            case .deleted: Icon(.fileX, size: 18).foregroundStyle(Palette.red500)
            case .modified: Icon(.filePen, size: 18).foregroundStyle(Self.yellow)
            case .renamed: Icon(.file, size: 18).foregroundStyle(Self.blue)
            case .copied, .typechange: Icon(.file, size: 18).foregroundStyle(Palette.t300)
            }
        }
    }

    /// getStatusLabel, `U` for untracked.
    static func letter(status: GitFileStatus, isUntracked: Bool) -> (text: String, color: Color) {
        if isUntracked { return ("U", green) }
        switch status {
        case .added: return ("A", green)
        case .deleted: return ("D", Palette.red500)
        case .modified: return ("M", yellow)
        case .renamed: return ("R", blue)
        case .copied: return ("C", Palette.t300)
        case .typechange: return ("T", Palette.t300)
        }
    }
}

/// `.intb`: Rebase onto (outlined) and Merge into (primary), with a count badge.
private struct IntegrationButton: View {
    enum Kind { case rebase, merge }
    let title: String
    let badge: String?
    let hint: String
    let kind: Kind
    let isEnabled: Bool
    let isBusy: Bool
    let action: () -> Void

    /// Busy keeps the enabled colours (the button shows its own progress).
    private var active: Bool { isEnabled || isBusy }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title).textStyle(TextStyle(size: 14, weight: kind == .merge ? 500 : 400))
                Spacer(minLength: 0)
                if let badge {
                    Text(badge)
                        .textStyle(TextStyle(size: 11, tabular: true))
                        .foregroundStyle(kind == .merge && active ? Palette.primaryForeground : Palette.t300)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 4)
                            .fill(kind == .merge && active ? Palette.primaryForeground.opacity(0.2) : Palette.bg80))
                }
            }
            .foregroundStyle(!active ? Palette.disabledForeground : kind == .merge ? Palette.primaryForeground : Palette.fg)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background {
                switch kind {
                case .merge: RoundedRectangle(cornerRadius: 6).fill(active ? Palette.primary : Palette.disabledFill)
                case .rebase:
                    RoundedRectangle(cornerRadius: 6).surface(Palette.bg80, elevation: .hairline)
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.border))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel(title)
        .accessibilityValue(badge ?? "")
        .accessibilityHint(hint)
    }
}
