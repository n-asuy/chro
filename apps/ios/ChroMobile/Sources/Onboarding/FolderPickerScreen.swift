import ChroDomain
import ChroServices
import SwiftUI

/// "Select workspace" (folder-picker-dialog.tsx): browse the desktop's
/// folders, then open the chosen one as a project (lib/open-workspace.ts).
struct FolderPickerScreen: View {
    let onCancel: () -> Void
    let onOpened: (ProjectSummary) -> Void
    @Environment(WorkspaceStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @State private var path: String?
    @State private var listing: DirectoryListing?
    @State private var error: String?
    @State private var loading = true
    @State private var opening = false

    var body: some View {
        VStack(spacing: 0) {
            NavBar(title: "Select workspace", onBack: onCancel) { Color.clear.frame(width: 44, height: 44) }
            Text("Choose a folder to open as your workspace")
                .textStyle(.link).foregroundStyle(Palette.t300)
                .padding(.horizontal, 20).padding(.bottom, 10)
            toolbar
            list
            VStack(spacing: 8) {
                BigButton(title: "Select", isEnabled: path != nil && !opening) { select() }
                BigButton(title: "Cancel", kind: .outline, action: onCancel)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)
        }
        .background(Palette.bg.ignoresSafeArea())
        .task { await goHome() }
    }

    private var toolbar: some View {
        let parent = path.flatMap(DirectoryListing.parent(of:))
        return HStack(spacing: 6) {
            squareButton(.house, label: "Home directory") { Task { await goHome() } }
            squareButton(.chevronUp, label: "Parent directory", enabled: parent != nil) { if let parent { Task { await go(parent) } } }
            Text(path ?? "Home")
                .textStyle(TextStyle(size: 14)).foregroundStyle(Palette.t300)
                .lineLimit(1).truncationMode(.head)
                .frame(maxWidth: .infinity, alignment: .leading)
            if listing?.isGitRepository == true { GitChip() }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 10)
    }

    private func squareButton(_ icon: LucideName, label: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(icon, size: 17).foregroundStyle(Palette.fg)
                .frame(width: 44, height: 40)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.border))
                .minimumHitArea()
        }
        .buttonStyle(PressableStyle())
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
        .accessibilityLabel(label)
    }

    private var list: some View {
        ScrollView {
            VStack(spacing: 0) {
                if loading {
                    HStack(spacing: 8) { Spinner(size: 16); Text("Loading...") }
                        .textStyle(TextStyle(size: 14)).foregroundStyle(Palette.t300).padding(16)
                } else if let error {
                    Text(error).textStyle(TextStyle(size: 14)).foregroundStyle(Palette.destructive).padding(16)
                } else if let listing, listing.entries.isEmpty {
                    Text("Empty directory").textStyle(TextStyle(size: 14)).foregroundStyle(Palette.t300).padding(16)
                } else if let listing {
                    ForEach(listing.entries) { entry in row(entry, in: listing.path) }
                }
            }
            .frame(maxWidth: .infinity)
            .padding(4)
        }
        .background(RoundedRectangle(cornerRadius: 6).fill(Palette.bg90))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.border))
        .padding(.horizontal, 16)
    }

    @ViewBuilder private func row(_ entry: DirectoryListing.Entry, in directory: String) -> some View {
        let content = HStack(spacing: 10) {
            Icon(entry.isDirectory ? .folder : .file, size: 17).foregroundStyle(Palette.t300)
            Text(entry.name).textStyle(TextStyle(size: 15)).foregroundStyle(Palette.fg).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if entry.isGitRepository { GitChip() }
            if entry.isDirectory { Icon(.chevronRight, size: 16).foregroundStyle(Palette.t300) }
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 44)
        if entry.isDirectory {
            Button { Task { await go(directory == "/" ? "/\(entry.name)" : "\(directory)/\(entry.name)") } } label: { content }
                .buttonStyle(PressableStyle(cornerRadius: 4, pressedFill: Palette.bg80))
        } else {
            content.opacity(0.5)
        }
    }

    private func goHome() async {
        loading = true
        do { await go(try await store.services.projects.homeDirectory()) } catch {
            self.error = (error as? ServiceError)?.message ?? "Failed to load directory"
            loading = false
        }
    }

    private func go(_ target: String) async {
        path = target
        loading = true
        error = nil
        do {
            listing = try await store.services.projects.listDirectory(path: target)
        } catch {
            listing = nil
            self.error = (error as? ServiceError)?.message ?? "Failed to load directory"
        }
        loading = false
    }

    private func select() {
        guard let path else { return }
        opening = true
        Task {
            do {
                onOpened(try await store.services.projects.openWorkspace(path: path))
            } catch {
                toasts.show("Failed to open workspace", description: (error as? ServiceError)?.message ?? error.localizedDescription)
            }
            opening = false
        }
    }
}

/// `.gitchip`
struct GitChip: View {
    var body: some View {
        Text("Git").textStyle(TextStyle(size: 12)).foregroundStyle(Palette.t300)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4).fill(Palette.bg80))
    }
}
