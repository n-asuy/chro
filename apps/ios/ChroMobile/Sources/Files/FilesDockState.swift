import ChroDomain
import ChroServices
import Foundation
import Observation

/// What the Files, Search and Agent panels keep while the dock sheet is
/// closed or replaced by one of their own sheets (the desktop keeps the same
/// in its files and right-dock stores). One instance lives for the app run.
@MainActor @Observable
final class FilesDockState {
    static let shared = FilesDockState()

    /// The session tree's two views (files-store `worktreeScopeView`).
    enum TreeView: String { case changed, all }

    /// The project root row's key in `expanded`.
    static let rootKey = ""

    var treeView: TreeView = .changed
    private var expandedByScope: [CheckoutScope: Set<String>] = [:]
    private var selectedByScope: [CheckoutScope: String] = [:]
    /// The entry whose name is being edited inline.
    var renaming: (scope: CheckoutScope, path: String)?
    /// A delete waiting for the confirmation dialog.
    var pendingDelete: PendingDelete?
    /// The Agent panel's directory per project (`""` is the root), set by tapping a folder.
    var agentTargets: [String: String] = [:]
    private var searches: [String: SearchState] = [:]

    struct PendingDelete: Equatable {
        var projectID: String
        var path: String
        var isDirectory: Bool
    }

    /// The Search panel of one project.
    struct SearchState: Equatable {
        var query = ""
        var matchCase = false
        var sort: FileSearchSort = .relevance
        var collapsed: Set<String> = []
    }

    // MARK: - Tree

    func expanded(_ scope: CheckoutScope) -> Set<String> { expandedByScope[scope] ?? [Self.rootKey] }

    func isExpanded(_ path: String, in scope: CheckoutScope) -> Bool { expanded(scope).contains(path) }

    func toggle(_ path: String, in scope: CheckoutScope) {
        var set = expanded(scope)
        if set.contains(path) { set.remove(path) } else { set.insert(path) }
        expandedByScope[scope] = set
    }

    /// Opens the root and every folder above `path` (and `path` itself when it is a folder).
    func reveal(_ path: String, in scope: CheckoutScope, includingSelf: Bool = false) {
        var set = expanded(scope)
        set.insert(Self.rootKey)
        set.formUnion(FileTree.ancestors(of: path))
        if includingSelf { set.insert(path) }
        expandedByScope[scope] = set
    }

    /// Collapse all: every folder closes, the root stays open.
    func collapseAll(_ scope: CheckoutScope) { expandedByScope[scope] = [Self.rootKey] }

    func selected(_ scope: CheckoutScope) -> String? { selectedByScope[scope] }

    func select(_ path: String?, in scope: CheckoutScope) { selectedByScope[scope] = path }

    /// Keeps expansion and selection on an entry that was renamed or moved.
    func relocate(from: String, to: String, in scope: CheckoutScope) {
        expandedByScope[scope] = Set(expanded(scope).map { FileNaming.relocate($0, from: from, to: to) })
        if let selected = selectedByScope[scope] { selectedByScope[scope] = FileNaming.relocate(selected, from: from, to: to) }
    }

    // MARK: - Search

    func search(_ projectID: String) -> SearchState { searches[projectID] ?? SearchState() }

    func updateSearch(_ projectID: String, _ change: (inout SearchState) -> Void) {
        var state = search(projectID)
        change(&state)
        searches[projectID] = state
    }

    // MARK: - History (per device, lib/search-history.ts)

    static let historyKey = "chro.search-history"

    var history: [String] = UserDefaults.standard.stringArray(forKey: FilesDockState.historyKey) ?? [] {
        didSet { UserDefaults.standard.set(history, forKey: Self.historyKey) }
    }

    func remember(_ query: String) { history = FileSearchInput.pushHistory(query, onto: history) }
}
