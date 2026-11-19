import ChroDomain
import ChroServices
import Foundation
import Observation

/// The state of the Source Control panel (source-control-panel.tsx and
/// use-git-status.ts) for one checkout. Git failures surface as toasts with
/// `GitErrorMessage`; a status that cannot be read leaves the panel empty
/// with "No branch", as on the desktop.
@MainActor @Observable
final class SourceControlModel {
    /// "All changes" compares the branch with its target; "Uncommitted" is the working tree only.
    enum Scope: String { case all, uncommitted }

    let checkout: CheckoutScope
    private let service: any SourceControlService

    private(set) var status: GitStatusSnapshot?
    private(set) var branch: BranchStatus?
    /// The files of the selected scope with their line counts.
    private(set) var changes: [FileChange] = []
    private(set) var isLoading = false
    private(set) var isCommitting = false
    private(set) var isRebasing = false
    private(set) var isMerging = false
    private(set) var didMerge = false

    var scope: Scope { didSet { if scope != oldValue { Task { await loadChanges() } } } }
    var viewMode: ChangeFileTree.Mode {
        didSet { UserDefaults.standard.set(viewMode.rawValue, forKey: Self.viewModeKey) }
    }
    var commitMessage = SourceControlModel.defaultCommitMessage()
    var collapsedSections: Set<String> = []
    var collapsedFolders: Set<String> = []

    /// Persisted like the desktop's `chro.sourceControl.fileViewMode`.
    static let viewModeKey = "chro.sourceControl.fileViewMode"

    /// Reports a git failure (the toast title).
    var onFailure: (String) -> Void = { _ in }
    /// Reports a finished verb that the desktop confirms with a toast.
    var onNotice: (String) -> Void = { _ in }

    init(checkout: CheckoutScope, service: any SourceControlService) {
        self.checkout = checkout
        self.service = service
        scope = checkout.isRun ? .all : .uncommitted
        viewMode = UserDefaults.standard.string(forKey: Self.viewModeKey) == ChangeFileTree.Mode.tree.rawValue ? .tree : .list
    }

    var sessionID: String? { if case .run(let id) = checkout { id } else { nil } }

    /// The run's target branch; the project compares against main.
    var baseRef: String? { checkout.isRun ? branch?.targetBranch : "main" }

    var integration: IntegrationState {
        IntegrationState(targetBranch: branch?.targetBranch, commitsAhead: branch?.commitsAhead ?? 0, commitsBehind: branch?.commitsBehind ?? 0,
                         conflictedFileCount: branch?.conflictedFiles.count ?? 0, isRebaseInProgress: branch?.isRebaseInProgress ?? false,
                         isRebasing: isRebasing, isMerging: isMerging, didMerge: didMerge)
    }

    var stagedCount: Int { status?.staged.count ?? 0 }
    var changesCount: Int { (status?.modified.count ?? 0) + (status?.untracked.count ?? 0) }
    var canCommit: Bool { stagedCount > 0 && !commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var pushCount: Int { max(0, status?.commitsAhead ?? 0) }
    var pullCount: Int { max(0, status?.commitsBehind ?? 0) }

    var canViewAllChanges: Bool {
        guard !isLoading else { return false }
        return scope == .all ? !changes.isEmpty : stagedCount + changesCount > 0
    }

    func counts(_ path: String) -> (additions: Int, deletions: Int) {
        let change = changes.first { $0.path == path }
        return (change?.additions ?? 0, change?.deletions ?? 0)
    }

    // MARK: Loading

    /// Loads, then follows the checkout's changes until the task is cancelled.
    func run() async {
        for await _ in service.updates(checkout) {
            await reload()
        }
    }

    func reload() async {
        isLoading = true
        defer { isLoading = false }
        do {
            status = try await service.status(checkout)
        } catch {
            status = nil
        }
        if let sessionID { branch = try? await service.branchStatus(sessionID: sessionID) }
        await loadChanges()
    }

    private func loadChanges() async {
        // Until the run's target is known no base is correct; hold the request.
        if scope == .all && checkout.isRun && baseRef == nil { changes = []; return }
        changes = (try? await service.changes(checkout, base: scope == .all ? baseRef : nil)) ?? []
    }

    // MARK: Verbs

    func stage(_ paths: [String]) async {
        guard !paths.isEmpty else { return }
        await apply(.stage) { try await self.service.stage(self.checkout, paths: paths) }
    }

    func unstage(_ paths: [String]) async {
        guard !paths.isEmpty else { return }
        await apply(.unstage) { try await self.service.unstage(self.checkout, paths: paths) }
    }

    func stageAll() async {
        await stage((status?.modified.map(\.path) ?? []) + (status?.untracked ?? []))
    }

    func unstageAll() async { await unstage(status?.staged.map(\.path) ?? []) }

    func discard(_ paths: [String]) async {
        await apply(.discardFiles) { try await self.service.discard(self.checkout, paths: paths) }
    }

    func discardAll() async {
        await apply(.discard) { try await self.service.discardAll(self.checkout) }
    }

    func commit() async {
        guard canCommit, !isCommitting else { return }
        isCommitting = true
        defer { isCommitting = false }
        do {
            try await service.commit(checkout, message: commitMessage)
            commitMessage = Self.defaultCommitMessage()
            await reload()
        } catch {
            await failed(error, .commit)
        }
    }

    func push() async {
        isLoading = true
        defer { isLoading = false }
        do {
            status = try await service.push(checkout)
            onNotice("Push to remote")
        } catch {
            await failed(error, .push)
        }
    }

    func pull() async {
        isLoading = true
        defer { isLoading = false }
        do {
            status = try await service.pull(checkout)
            onNotice("Pull from remote")
        } catch {
            await failed(error, .pull)
        }
    }

    func rebase() async {
        guard let sessionID, let base = baseRef, integration.canRebase else { return }
        isRebasing = true
        defer { isRebasing = false }
        do {
            try await service.rebase(sessionID: sessionID, onto: base)
        } catch {
            onFailure(Self.message(error, .rebase))
        }
        await reload()
    }

    func merge() async {
        guard let sessionID, integration.canMerge else { return }
        isMerging = true
        defer { isMerging = false }
        do {
            try await service.merge(sessionID: sessionID)
            didMerge = true
        } catch {
            onFailure(Self.message(error, .merge))
        }
        await reload()
    }

    /// Focusing a still-default message refreshes its timestamp.
    func refreshDefaultMessage() {
        if commitMessage.hasPrefix("backup:") { commitMessage = Self.defaultCommitMessage() }
    }

    private func apply(_ fallback: GitErrorMessage.Fallback, _ verb: @escaping () async throws -> GitStatusSnapshot) async {
        do {
            status = try await verb()
            await loadChanges()
        } catch {
            await failed(error, fallback)
        }
    }

    /// Reports a failed change. When its answer was lost (deadline, disconnect) it may
    /// have taken effect, so the checkout is read again to show what actually happened.
    /// Rebase and merge read it again after every outcome already.
    private func failed(_ error: any Error, _ fallback: GitErrorMessage.Fallback) async {
        onFailure(Self.message(error, fallback))
        if (error as? ServiceError)?.isOutcomeUnknown == true { await reload() }
    }

    static func message(_ error: any Error, _ fallback: GitErrorMessage.Fallback) -> String {
        switch error {
        case SourceControlError.git(let text): return GitErrorMessage.resolve(text, fallback: fallback)
        case let error as ServiceError: return GitErrorMessage.resolve(error.message, fallback: fallback)
        default: return GitErrorMessage.resolve(error.localizedDescription, fallback: fallback)
        }
    }

    /// `backup: yyyy-MM-dd HH:mm:ss` in local time.
    static func defaultCommitMessage(now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return "backup: \(formatter.string(from: now))"
    }
}

extension CheckoutScope {
    var isRun: Bool { if case .run = self { true } else { false } }
}
