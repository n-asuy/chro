import ChroDomain
import ChroServices
import SwiftUI

/// The diff tab of a session's run (diff-viewer-panel.tsx) as a pushed
/// screen: totals, Unified / Split, Collapse All, and a card per file. Cards
/// start collapsed; the file the dock asked for opens and scrolls into view.
struct DiffScreen: View {
    let sessionID: String
    let focusPath: String?
    @Environment(\.panelServices) private var services
    @Environment(\.reportRouteFailure) private var reportFailure
    @Environment(Router.self) private var router
    @Environment(WorkspaceStore.self) private var store
    @State private var changes: [FileChange]?
    @State private var expanded: Set<String> = []
    @State private var mode: DiffLayout = .unified

    /// Opening more than this many cards at once is left to the user (DIFF_EXPAND_BATCH_SIZE).
    private static let expandBatch = 20

    var body: some View {
        VStack(spacing: 0) {
            NavBar(title: "Diff", onBack: { router.pop() }) {
                IconButton(icon: .x, size: 20, label: "Close Diff") { router.pop() }
            }
            if let changes {
                header(changes)
                if changes.isEmpty {
                    Text("No file changes yet.").textStyle(TextStyle(size: 14)).foregroundStyle(Palette.t300)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    cards(changes)
                }
            } else {
                Spinner(size: 20).foregroundStyle(Palette.t300)
                    .accessibilityLabel("Loading changes…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .task { await follow() }
    }

    private func follow() async {
        let scope = CheckoutScope.run(sessionID: sessionID)
        for await _ in services.sourceControl.updates(scope) {
            do {
                let loaded = try await services.sourceControl.runDiff(sessionID: sessionID)
                // Files that disappeared lose their open state; nothing else reopens.
                expanded.formIntersection(loaded.map(\.path))
                if changes == nil, let focusPath, loaded.contains(where: { $0.path == focusPath }) { expanded.insert(focusPath) }
                changes = loaded
            } catch {
                reportFailure(RouteFailure(error))
                return
            }
        }
    }

    // MARK: Header (`.dhead`)

    private func header(_ changes: [FileChange]) -> some View {
        let additions = changes.reduce(0) { $0 + ($1.additions ?? 0) }
        let deletions = changes.reduce(0) { $0 + ($1.deletions ?? 0) }
        let allCollapsed = expanded.isEmpty
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text("\(changes.count) \(changes.count == 1 ? "file" : "files") changed").foregroundStyle(Palette.t300)
                Text("+\(additions)").foregroundStyle(Palette.diffAdditionText)
                Text("-\(deletions)").foregroundStyle(Palette.diffDeletionText)
            }
            .textStyle(TextStyle(size: 13))
            .lineLimit(1)
            HStack(spacing: 6) {
                LayoutButton(title: "Unified", isOn: mode == .unified) { mode = .unified }
                LayoutButton(title: "Split", isOn: mode == .split) { mode = .split }
                Rectangle().fill(Palette.border).frame(width: 1, height: 16)
                LayoutButton(title: allCollapsed ? (changes.count > Self.expandBatch ? "Expand First \(Self.expandBatch)" : "Expand All") : "Collapse All",
                              isOn: false) {
                    expanded = allCollapsed ? Set(changes.prefix(Self.expandBatch).map(\.path)) : []
                }
                .accessibilityAddTraits(allCollapsed ? .isSelected : [])
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .padding(.top, 2)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
    }

    // MARK: Cards (`.dlist`)

    private func cards(_ changes: [FileChange]) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 16) {
                    ForEach(changes) { change in
                        DiffCard(change: change, scope: .run(sessionID: sessionID), layout: mode, isExpanded: expanded.contains(change.path),
                                 onToggle: { expanded.formSymmetricDifference([change.path]) },
                                 onOpen: { open(change.path) })
                            .id(change.path)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .task {
                guard let focusPath, changes.contains(where: { $0.path == focusPath }) else { return }
                try? await Task.sleep(for: .milliseconds(50))
                withAnimation { proxy.scrollTo(focusPath, anchor: .top) }
            }
        }
    }

    private func open(_ path: String) {
        let projectID = store.session(sessionID)?.projectID ?? ""
        router.push(.panel(.file(FileLocation(projectID: projectID, sessionID: sessionID, path: path))))
    }
}

enum DiffLayout { case unified, split }

/// `.dbtn`: Unified, Split, Collapse All.
private struct LayoutButton: View {
    let title: String
    let isOn: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .textStyle(TextStyle(size: 13, weight: 500))
                .foregroundStyle(Palette.t200)
                .padding(.horizontal, 10)
                .frame(height: 36)
                .background(RoundedRectangle(cornerRadius: 6).fill(isOn ? Palette.muted : .clear))
                // The 44pt hit area reaches past the 36pt button without growing the row.
                .padding(.vertical, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -4)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}
