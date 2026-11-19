import ChroDomain
import ChroServices
import SwiftUI
import UIKit

/// The dock's Files panel (file-tree-panel.tsx, file-tree.tsx). A session
/// with a worktree shows that worktree read-only, as Changed or All files;
/// otherwise the project's main checkout with New file and New folder.
struct FilesPanel: View {
    let context: DockContext
    @Environment(WorkspaceStore.self) private var store
    @Environment(SheetPresenter.self) private var sheets
    @Environment(Router.self) private var router
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.externalScreens) private var external
    @Environment(\.panelServices) private var services
    @State private var state = FilesDockState.shared
    @State private var entries: [FileTreeEntry] = []
    @State private var changed: [String] = []
    /// `context.revealPath` until its row has been scrolled into view.
    @State private var pendingReveal: String?

    private var scope: CheckoutScope { context.checkoutScope(in: store) }
    private var isRun: Bool { if case .run = scope { true } else { false } }
    private var navigator: FilesNavigator {
        FilesNavigator(context: context, sheets: sheets, router: router, external: external, services: services)
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            ScrollViewReader { reader in
                ScrollView {
                    tree.padding(.horizontal, 4).padding(.vertical, 6)
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.interactively)
                .keyboardOverlapMargin()
                // Like the desktop, bring the row being named into view (above the keyboard).
                .onChange(of: state.renaming?.path) { _, path in
                    guard let path else { return }
                    withAnimation { reader.scrollTo(path, anchor: UnitPoint(x: 0.5, y: 0.25)) }
                }
                .onChange(of: entries) { _, _ in
                    if let path = state.renaming?.path {
                        reader.scrollTo(path, anchor: UnitPoint(x: 0.5, y: 0.25))
                    } else if let path = pendingReveal, entries.contains(where: { $0.path == path }) {
                        pendingReveal = nil
                        reader.scrollTo(path, anchor: .center)
                    }
                }
            }
        }
        .onAppear(perform: reveal)
        .task(id: scope) { await watch() }
        .confirmationDialog(state.pendingDelete.map { FileNaming.deleteTitle(name: FileTreeEntry(path: $0.path, isDirectory: $0.isDirectory).name) } ?? "",
                            isPresented: Binding(get: { state.pendingDelete != nil }, set: { if !$0 { state.pendingDelete = nil } }),
                            titleVisibility: .visible, presenting: state.pendingDelete) { pending in
            Button("Delete", role: .destructive) { Task { await delete(pending) } }
            Button("Cancel", role: .cancel) { state.pendingDelete = nil }
        } message: { pending in
            Text(FileNaming.deleteMessage(isDirectory: pending.isDirectory))
        }
    }

    // MARK: - Toolbar (`.ft-tool`)

    private var toolbar: some View {
        HStack(spacing: 4) {
            IconButton(icon: .minimize2, size: 18, label: "Collapse all") { state.collapseAll(scope) }
            if isRun {
                FilesViewToggle(selection: Binding(get: { state.treeView }, set: { state.treeView = $0 }))
                    .padding(.leading, 4)
                Spacer(minLength: 0)
                IconButton(icon: .images, size: 18, label: "Open gallery") { navigator.openGallery() }
            } else {
                IconButton(icon: .plus, size: 18, label: "New file") {
                    navigator.present { NewFileSheet(context: context, directory: "") }
                }
                IconButton(icon: .folderPlus, size: 18, label: "New folder") { Task { await createFolderAtSelection() } }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 6)
        .frame(height: 48)
    }

    // MARK: - Tree

    @ViewBuilder private var tree: some View {
        let showsChanged = isRun && state.treeView == .changed
        if showsChanged && changed.isEmpty {
            SheetHint(text: "No changes yet")
        } else {
            let fileTree = showsChanged ? FileTree.changed(paths: changed) : FileTree(entries: entries)
            let rootOpen = showsChanged || state.isExpanded(FilesDockState.rootKey, in: scope)
            let rows = rootOpen ? (showsChanged ? fileTree.rows(expandAll: true) : fileTree.rows(expanded: state.expanded(scope))) : []
            // Read here, not inside the lazy rows, so a change re-renders the tree.
            let renamingPath = state.renaming.flatMap { $0.scope == scope ? $0.path : nil }
            let selectedPath = state.selected(scope)
            LazyVStack(alignment: .leading, spacing: 0) {
                TreeRow(name: rootName, depth: 0, isDirectory: true, isExpanded: rootOpen, isSelected: false,
                        onTap: { if !showsChanged { state.toggle(FilesDockState.rootKey, in: scope) }; state.agentTargets[context.projectID] = "" },
                        onLongPress: isRun ? nil : { openMenu(path: "", isDirectory: true) })
                ForEach(rows) { row in
                    // One identity per path (ForEach), whichever form the row takes.
                    if renamingPath == row.path {
                        RenameRow(depth: row.depth, name: row.name,
                                  selection: FileNaming.renameSelection(row.name, isDirectory: row.isDirectory)) { typed in
                            Task { await commitRename(row.entry, to: typed) }
                        }
                    } else {
                        TreeRow(name: row.name, depth: row.depth, isDirectory: row.isDirectory, isExpanded: row.isExpanded,
                                isSelected: selectedPath == row.path,
                                onTap: { tap(row, expandsAll: showsChanged) },
                                onLongPress: { openMenu(path: row.path, isDirectory: row.isDirectory) })
                    }
                }
            }
        }
    }

    /// Opens the tree down to `context.revealPath` and selects it (a skill
    /// card's SKILL.md); the all-files view shows it in a session's worktree.
    private func reveal() {
        guard let path = context.revealPath, !path.isEmpty else { return }
        if isRun { state.treeView = .all }
        state.reveal(path, in: scope)
        state.select(path, in: scope)
        pendingReveal = path
    }

    private var rootName: String { store.project(context.projectID)?.name ?? "" }

    private func tap(_ row: FileTree.Row, expandsAll: Bool) {
        if row.isDirectory {
            if !expandsAll { state.toggle(row.path, in: scope) }
            state.agentTargets[context.projectID] = row.path
            return
        }
        state.select(row.path, in: scope)
        navigator.openFile(row.path)
    }

    private func openMenu(path: String, isDirectory: Bool) {
        guard state.renaming == nil else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if !path.isEmpty { state.select(path, in: scope) }
        let entries = entries
        navigator.present {
            TreeMenuSheet(context: context, scope: scope, path: path, isDirectory: isDirectory, rootName: rootName, entries: entries)
        }
    }

    // MARK: - Loading

    /// Loads the tree, then reloads whenever the checkout changes on disk.
    private func watch() async {
        for await _ in services.files.changes(scope) {
            await load()
        }
    }

    private func load() async {
        let scope = scope
        entries = (try? await services.files.entries(scope)) ?? []
        if case .run(let sessionID) = scope {
            changed = (try? await services.files.changedPaths(sessionID: sessionID)) ?? []
        }
    }

    // MARK: - Writes

    private func createFolderAtSelection() async {
        let selected = state.selected(scope)
        let directory = selected.flatMap { path in entries.first { $0.path == path && $0.isDirectory }?.path } ?? ""
        await TreeWrites(services: services, toasts: toasts).create(.folder, in: directory, projectID: context.projectID, entries: entries)
        await load()
    }

    private func commitRename(_ entry: FileTreeEntry, to typed: String) async {
        guard let renaming = state.renaming, renaming.path == entry.path else { return }
        state.renaming = nil
        let existing = Set(entries.map(\.path))
        guard let target = FileNaming.renameTarget(from: entry.path, to: typed, existing: existing) else { return }
        do {
            try await services.files.rename(projectID: context.projectID, from: entry.path, to: target)
            state.relocate(from: entry.path, to: target, in: renaming.scope)
        } catch {
            toasts.show(filesErrorMessage(error))
        }
        await load()
    }

    private func delete(_ pending: FilesDockState.PendingDelete) async {
        state.pendingDelete = nil
        do {
            try await services.files.delete(projectID: pending.projectID, path: pending.path)
        } catch {
            toasts.show(filesErrorMessage(error))
        }
        await load()
    }
}

extension FilesPanel {
    /// Starts the inline rename of a just-created or picked entry.
    @MainActor static func beginRename(_ path: String, in scope: CheckoutScope) {
        let state = FilesDockState.shared
        state.reveal(path, in: scope)
        state.select(path, in: scope)
        state.renaming = (scope, path)
    }
}

/// The server's message for a failed file operation.
func filesErrorMessage(_ error: any Error) -> String {
    (error as? ServiceError)?.message ?? error.localizedDescription
}

/// Create on disk with the default name, then start the inline rename (files-store `createFile` / `createFolder`).
@MainActor
struct TreeWrites {
    let services: PanelServices
    let toasts: ToastCenter

    func create(_ kind: NewEntryKind, in directory: String, projectID: String, entries: [FileTreeEntry]) async {
        let siblings = entries.filter { FileTree.parent(of: $0.path) == directory }.map(\.name)
        let name = FileNaming.newEntryName(kind, siblings: siblings)
        let path = directory.isEmpty ? name : "\(directory)/\(name)"
        do {
            if kind == .folder {
                try await services.files.createDirectory(projectID: projectID, path: path)
            } else {
                try await services.files.createFile(projectID: projectID, path: path, content: FileNaming.initialContent(kind, directory: directory))
            }
            FilesPanel.beginRename(path, in: .project(id: projectID))
        } catch {
            toasts.show(filesErrorMessage(error))
        }
    }
}

/// `.tnode`: a 44pt tree row with the chevron column and the name.
private struct TreeRow: View {
    let name: String
    let depth: Int
    let isDirectory: Bool
    let isExpanded: Bool
    let isSelected: Bool
    let onTap: () -> Void
    let onLongPress: (() -> Void)?

    var body: some View {
        HStack(spacing: 0) {
            Icon(.chevronRight, size: 16)
                .foregroundStyle(Palette.t400)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                .animation(.easeOut(duration: 0.15), value: isExpanded)
                .frame(width: 24, height: 24)
                .opacity(isDirectory ? 1 : 0)
                .padding(.trailing, 4)
            Text(name)
                .textStyle(TextStyle(size: 14, weight: 500, tracking: 0.01))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .foregroundStyle(isSelected ? Palette.fg : Palette.t200)
        .padding(.leading, TreeRow.indent(depth))
        .padding(.trailing, 8)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(isSelected ? Palette.primary.opacity(0.1) : .clear))
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
        .onLongPressGesture(minimumDuration: 0.48) { onLongPress?() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name)
        .accessibilityAddTraits(.isButton)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityValue(isDirectory ? (isExpanded ? "Expanded" : "Collapsed") : "")
        .accessibilityAction(named: "More") { onLongPress?() }
        .accessibilityIdentifier("tree:\(name)")
    }

    /// `padding-left: 18 + (depth - 1) * 16`, the root row 4.
    static func indent(_ depth: Int) -> CGFloat { depth == 0 ? 4 : CGFloat(18 + (depth - 1) * 16) }
}

/// A tree row whose name is being edited (`input.ren`): Return or leaving the field commits.
private struct RenameRow: View {
    let depth: Int
    let name: String
    let selection: Range<Int>
    let onCommit: (String) -> Void

    var body: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: 28, height: 24)
            RenameField(initial: name, selection: selection, onCommit: onCommit)
                .frame(minHeight: 30)
        }
        .padding(.leading, TreeRow.indent(depth))
        .padding(.trailing, 8)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Palette.primary.opacity(0.1)))
    }
}

/// A text field that starts focused with part of its text selected (the name without the extension).
private struct RenameField: UIViewRepresentable {
    let initial: String
    let selection: Range<Int>
    let onCommit: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> SelectingTextField {
        let field = SelectingTextField()
        field.initialSelection = selection
        field.font = TextStyle(size: 14, weight: 500).scalingUIFont
        field.adjustsFontForContentSizeCategory = true
        field.textColor = UIColor(Palette.fg)
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.returnKeyType = .done
        field.borderStyle = .none
        field.layer.borderColor = UIColor(Palette.primary).cgColor
        field.layer.borderWidth = 1
        field.layer.cornerRadius = 4
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 6, height: 1))
        field.leftViewMode = .always
        field.text = initial
        field.delegate = context.coordinator
        field.accessibilityLabel = "Rename"
        return field
    }

    func updateUIView(_ field: SelectingTextField, context: Context) { context.coordinator.parent = self }

    /// Return commits; so does leaving the field, unless the field is leaving the screen
    /// (a re-render or the sheet closing), which keeps the rename pending. The panel
    /// ignores a second commit of the same rename.
    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: RenameField

        init(_ parent: RenameField) { self.parent = parent }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            parent.onCommit(field.text ?? "")
            field.resignFirstResponder()
            return false
        }

        func textFieldDidEndEditing(_ field: UITextField) {
            guard field.window != nil else { return }
            parent.onCommit(field.text ?? "")
        }
    }
}

/// Takes focus once it is on screen and selects `initialSelection` (UTF-16 offsets of the name).
final class SelectingTextField: UITextField {
    var initialSelection: Range<Int>?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, initialSelection != nil else { return }
        // A sheet that is still animating in can refuse first responder; retry until it sticks.
        focusAndSelect(attempts: 10)
    }

    private func focusAndSelect(attempts: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self, self.window != nil, let selection = self.initialSelection else { return }
            guard self.becomeFirstResponder() else {
                if attempts > 1 { self.focusAndSelect(attempts: attempts - 1) }
                return
            }
            self.initialSelection = nil
            if let start = self.position(from: self.beginningOfDocument, offset: selection.lowerBound),
               let end = self.position(from: self.beginningOfDocument, offset: selection.upperBound) {
                self.selectedTextRange = self.textRange(from: start, to: end)
            }
        }
    }
}

/// `.scope`: the session tree's Changed / All files switch.
struct FilesViewToggle: View {
    @Binding var selection: FilesDockState.TreeView

    var body: some View {
        ScopeSwitch(selection: $selection, options: [(.changed, "Changed"), (.all, "All files")])
            .accessibilityElement(children: .contain)
            .accessibilityLabel("File tree view")
    }
}
