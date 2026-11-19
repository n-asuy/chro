import ChroDomain
import ChroServices
import SwiftUI
import UIKit

/// The environment a Files sheet needs to act and to go back to the dock.
private struct FilesSheetEnvironment {
    let context: DockContext
    let sheets: SheetPresenter
    let router: Router
    let external: ExternalScreens
    let services: PanelServices

    var navigator: FilesNavigator {
        FilesNavigator(context: context, sheets: sheets, router: router, external: external, services: services)
    }
}

/// The long-press menu of a tree row (tree-context-menu.tsx). A session's
/// worktree is read-only: only the path copies are offered there.
struct TreeMenuSheet: View {
    let context: DockContext
    let scope: CheckoutScope
    /// `""` for the project root row.
    let path: String
    let isDirectory: Bool
    let rootName: String
    let entries: [FileTreeEntry]
    @Environment(SheetPresenter.self) private var sheets
    @Environment(Router.self) private var router
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.externalScreens) private var external
    @Environment(\.panelServices) private var services

    private var navigator: FilesNavigator {
        FilesSheetEnvironment(context: context, sheets: sheets, router: router, external: external, services: services).navigator
    }

    private var name: String { path.isEmpty ? rootName : FileTreeEntry(path: path, isDirectory: isDirectory).name }
    private var isRun: Bool { if case .run = scope { true } else { false } }
    /// Where New file and New folder create: the folder itself, or the file's folder.
    private var targetDirectory: String { isDirectory ? path : FileTree.parent(of: path) }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: name, onDone: { navigator.returnToDock() })
            SheetMenu {
                if isRun {
                    copyRows
                } else {
                    MenuItem(icon: .filePlus, title: "New file", disclosure: true) {
                        let directory = targetDirectory
                        navigator.present { NewFileSheet(context: context, directory: directory) }
                    }
                    MenuItem(icon: .folderPlus, title: "New folder") { Task { await create(.folder) } }
                    if !path.isEmpty {
                        MenuSeparator()
                        MenuItem(icon: .folderInput, title: "Move to…") {
                            let (path, entries) = (path, entries)
                            navigator.present(tall: true) { MoveSheet(context: context, path: path, entries: entries) }
                        }
                        MenuSeparator()
                        copyRows
                        MenuSeparator()
                        MenuItem(icon: .copyPlus, title: "Duplicate") { Task { await duplicate() } }
                        MenuItem(icon: .pencil, title: "Rename") {
                            FilesPanel.beginRename(path, in: scope)
                            navigator.returnToDock()
                        }
                        MenuSeparator()
                        DeleteMenuItem {
                            FilesDockState.shared.pendingDelete = .init(projectID: context.projectID, path: path, isDirectory: isDirectory)
                            navigator.returnToDock()
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var copyRows: some View {
        MenuItem(icon: .copy, title: "Copy Full Path") { Task { await copy(full: true) } }
        MenuItem(icon: .fileText, title: "Copy Relative Path") { Task { await copy(full: false) } }
    }

    private func copy(full: Bool) async {
        if full {
            guard let root = try? await services.files.checkoutRoot(scope) else { return }
            UIPasteboard.general.string = "\(root)/\(path)"
        } else {
            UIPasteboard.general.string = path
        }
        navigator.returnToDock()
    }

    private func create(_ kind: NewEntryKind) async {
        await TreeWrites(services: services, toasts: toasts).create(kind, in: targetDirectory, projectID: context.projectID, entries: entries)
        navigator.returnToDock()
    }

    private func duplicate() async {
        let parent = FileTree.parent(of: path)
        let siblings = entries.filter { FileTree.parent(of: $0.path) == parent }.map(\.name)
        let copyName = FileNaming.duplicateName(name, isDirectory: isDirectory, siblings: siblings)
        let target = parent.isEmpty ? copyName : "\(parent)/\(copyName)"
        do {
            try await services.files.copy(projectID: context.projectID, from: path, to: target)
            FilesDockState.shared.select(target, in: scope)
        } catch {
            toasts.show(filesErrorMessage(error))
        }
        navigator.returnToDock()
    }
}

/// The destructive row: `#DC2626` text and glyph.
private struct DeleteMenuItem: View {
    let action: () -> Void

    var body: some View {
        SheetMenuRow(action: action) {
            Icon(.trash, size: 18)
            Text("Delete")
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color(hex: 0xDC2626))
        .accessibilityLabel("Delete")
    }
}

/// New file: Markdown, drawing or Database in a folder.
struct NewFileSheet: View {
    let context: DockContext
    let directory: String
    @Environment(SheetPresenter.self) private var sheets
    @Environment(Router.self) private var router
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.externalScreens) private var external
    @Environment(\.panelServices) private var services

    private var navigator: FilesNavigator {
        FilesSheetEnvironment(context: context, sheets: sheets, router: router, external: external, services: services).navigator
    }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "New file", onBack: { navigator.returnToDock() }, onDone: { navigator.returnToDock() })
            SheetMenu {
                ForEach(NewEntryKind.fileKinds, id: \.self) { kind in
                    MenuItem(icon: kind.icon, title: kind.label) { Task { await create(kind) } }
                }
            }
        }
    }

    private func create(_ kind: NewEntryKind) async {
        let entries = (try? await services.files.entries(.project(id: context.projectID))) ?? []
        await TreeWrites(services: services, toasts: toasts).create(kind, in: directory, projectID: context.projectID, entries: entries)
        navigator.returnToDock()
    }
}

private extension NewEntryKind {
    var icon: LucideName {
        switch self {
        case .markdown: return .fileText
        case .drawing: return .penLine
        case .database: return .database
        case .folder: return .folderPlus
        }
    }
}

/// Move to… (move-selection-dialog.tsx): pick a folder of the project, then Move.
struct MoveSheet: View {
    let context: DockContext
    let path: String
    let entries: [FileTreeEntry]
    @State private var query = ""
    @State private var destination: String?
    @Environment(SheetPresenter.self) private var sheets
    @Environment(Router.self) private var router
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.externalScreens) private var external
    @Environment(\.panelServices) private var services

    private var navigator: FilesNavigator {
        FilesSheetEnvironment(context: context, sheets: sheets, router: router, external: external, services: services).navigator
    }

    var body: some View {
        let folders = FileNaming.moveDestinations(moving: path, folders: entries.filter(\.isDirectory).map(\.path), query: query)
        VStack(spacing: 0) {
            SheetHeader(title: "Move 1 items", doneTitle: "Cancel", onDone: { navigator.returnToDock() })
            Text("Choose a destination folder in this project.")
                .textStyle(TextStyle(size: 13)).foregroundStyle(Palette.t300)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.bottom, 6)
            SheetSearchField(placeholder: "Search folders…", text: $query)
                .padding(.horizontal, 10).padding(.top, 4).padding(.bottom, 6)
            ScrollView {
                SheetMenu {
                    if folders.isEmpty {
                        SheetHint(text: "No matching folders")
                    }
                    ForEach(folders, id: \.self) { folder in
                        destinationRow(folder)
                    }
                }
            }
            .frame(maxHeight: .infinity)
            .keyboardOverlapMargin()
            BigButton(title: "Move", isEnabled: destination != nil) { Task { await move() } }
                .padding(.horizontal, 16).padding(.top, 8)
        }
    }

    private func destinationRow(_ folder: String) -> some View {
        let depth = folder.isEmpty ? 0 : folder.split(separator: "/").count - 1
        return SheetMenuRow(isHighlighted: destination == folder, action: { destination = folder }) {
            Icon(folder.isEmpty ? .folderRoot : .folder, size: 18).foregroundStyle(Palette.t300)
            VStack(alignment: .leading, spacing: 0) {
                Text(folder.isEmpty ? FileNaming.projectRootLabel : FileTreeEntry(path: folder, isDirectory: true).name)
                    .foregroundStyle(Palette.fg).lineLimit(1)
                if !folder.isEmpty {
                    Text(folder).textStyle(TextStyle(size: 12)).foregroundStyle(Palette.t300).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, CGFloat(depth) * 14)
        .accessibilityLabel(folder.isEmpty ? FileNaming.projectRootLabel : folder)
        .accessibilityAddTraits(destination == folder ? .isSelected : [])
    }

    private func move() async {
        guard let destination else { return }
        let target = FileNaming.moveTarget(moving: path, into: destination)
        let scope = CheckoutScope.project(id: context.projectID)
        if entries.contains(where: { $0.path == target }) {
            toasts.show("The selected items could not be moved.")
            return
        }
        do {
            try await services.files.rename(projectID: context.projectID, from: path, to: target)
            let state = FilesDockState.shared
            state.relocate(from: path, to: target, in: scope)
            state.select(target, in: scope)
            if !destination.isEmpty { state.reveal(destination, in: scope, includingSelf: true) }
        } catch {
            toasts.show("The selected items could not be moved.")
        }
        navigator.returnToDock()
    }
}
