import ChroDomain
import SwiftUI

/// A pushed screen. The root of the stack is the left panel.
enum Route: Hashable {
    /// The project overview tab ("Home").
    case home(projectID: String)
    /// The same launcher titled "New session".
    /// The same launcher titled "New session". `homeDir` (a directory relative to
    /// the project root) addresses the session there: the composer starts with
    /// that directory mentioned, as the desktop's "New session here" does.
    case newSession(projectID: String, homeDir: String? = nil)
    case session(id: String)
    /// "Select workspace", from onboarding or "Open another project".
    case folderPicker(FolderPickerContext)
    /// A screen of the right dock's family (diff, file, gallery, skills, release notes).
    case panel(PanelRoute)
}

/// Screens the right-dock module pushes above the left panel, from its own
/// sheets or from other screens (mobile architecture §14). Rendered by
/// `ExternalScreens.panel`.
enum PanelRoute: Hashable {
    /// The diff tab of a session's run, optionally scrolled to one file.
    case diff(sessionID: String, path: String?)
    /// A file opened in the editor or a viewer.
    case file(FileLocation)
    /// The project's media; a session narrows it to that run's worktree.
    case gallery(projectID: String, sessionID: String?)
    case skills(projectID: String)
    case releaseNotes
}

/// Which checkout a file belongs to: a session's worktree, or the project's main checkout.
struct FileLocation: Hashable {
    var projectID: String
    var sessionID: String?
    /// Path relative to the checkout root.
    var path: String
    /// 1-based line to reveal (search results).
    var line: Int?
}

enum FolderPickerContext: Hashable {
    case onboarding
    case openProject
}

@MainActor @Observable
final class Router {
    var path: [Route] = []

    var top: Route? { path.last }

    func push(_ route: Route) { path.append(route) }

    func pop() { if !path.isEmpty { path.removeLast() } }

    /// Replace the whole stack above the left panel.
    func reset(to routes: [Route]) { path = routes }

    /// Swap the top screen in place (the project switcher keeps the tab, changes the project).
    func replaceTop(with route: Route) {
        if path.isEmpty { path = [route] } else { path[path.count - 1] = route }
    }
}

/// Screens other modules of the app own (mobile architecture §7). The shell
/// links to them through this registry; an entry left nil means that screen
/// has not been provided yet, and the control that opens it is not offered.
struct ExternalScreens: Sendable {
    /// The conversation (Session/**).
    var session: (@MainActor @Sendable (_ sessionID: String) -> AnyView)?
    /// The right dock as a sheet, opened on a panel (Dock/**).
    var dock: (@MainActor @Sendable (_ context: DockContext) -> AnyView)?
    /// Settings sheet (Settings/**).
    var settings: (@MainActor @Sendable () -> AnyView)?
    /// Agent status sheet (System/**).
    var agentStatus: (@MainActor @Sendable () -> AnyView)?
    /// Feedback sheet (System/**).
    var feedback: (@MainActor @Sendable () -> AnyView)?
    /// Version chip label; the chip pushes `.panel(.releaseNotes)`.
    var appVersion: String?
    /// The pushed screens of `Route.panel` (Diff/**, Editor/**, Gallery/**, Skills/**, System/**).
    /// Home's Skills and Gallery and the version chip are offered only when this is set.
    var panel: (@MainActor @Sendable (_ route: PanelRoute) -> AnyView)?
    /// Path links of the conversation (tool rows, inline code, References):
    /// resolves path-like text against the desktop and opens hits in `panel`'s
    /// file screen (Files/PathLinks.swift). Nil leaves paths as plain text.
    var pathLinks: PathLinks?

    static let none = ExternalScreens()
}

/// What the dock opens on when the shell asks for it.
struct DockContext: Hashable {
    enum Panel: Hashable { case files, searchFiles, sourceControl }
    var projectID: String
    var sessionID: String?
    var panel: Panel?
    /// A path (relative to the checkout root) the Files panel expands to and selects.
    var revealPath: String? = nil
}

private struct ExternalScreensKey: EnvironmentKey {
    static let defaultValue = ExternalScreens.none
}

extension EnvironmentValues {
    var externalScreens: ExternalScreens {
        get { self[ExternalScreensKey.self] }
        set { self[ExternalScreensKey.self] = newValue }
    }
}
