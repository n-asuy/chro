import ChroServices
import Foundation

extension WorkspaceStore {
    /// The checkout the right dock reads (use-active-workspace-scope.ts): a
    /// session's worktree while it has one, else the project's main checkout.
    func checkoutScope(projectID: String, sessionID: String?) -> CheckoutScope {
        guard let sessionID else { return .project(id: projectID) }
        guard let session = session(sessionID) else { return .run(sessionID: sessionID) }
        return session.branch != nil && !session.worktreeDeleted ? .run(sessionID: sessionID) : .project(id: projectID)
    }
}

extension DockContext {
    @MainActor func checkoutScope(in store: WorkspaceStore) -> CheckoutScope {
        store.checkoutScope(projectID: projectID, sessionID: sessionID)
    }
}
