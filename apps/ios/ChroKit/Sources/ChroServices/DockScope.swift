import Foundation

/// Which checkout the right dock, the editor and the gallery read: the
/// project's main checkout (`/rpc/projects/:project_id/*`) or the worktree of
/// a session's latest run (`/rpc/task-runs/:id/*`). Sessions without their own
/// worktree read the project scope.
public enum CheckoutScope: Hashable, Sendable {
    case project(id: String)
    case run(sessionID: String)
}
