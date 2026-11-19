import ChroServices
import Foundation

/// Launch arguments for simulator checks and screenshot comparison:
///
///     -ChroFixture standard|fresh-host|bare-host|unpaired
///     -ChroScreen list|palette|home|new-session-model|onboarding-agent|new-chat|session|session-conflict|continue-in
///                 source-control|diff|file|gallery|skills|settings|conflict|file-editing|html-preview|
///                 release-notes|error-page|dock-files|dock-search|agent-status|feedback|
///                 workspace-picker|agent-directory|host-list
///     -ChroFocus <session id>   (the session last opened from the list; the session the session screens open)
///     -ChroLoseAnswers          (Source Control changes and settings saves take effect, then their answer is lost)
///     -ChroMotionScale <n>      (sheet motion runs n times slower, so UI tests can sample it mid-flight)
///     -ChroReplyPace <ms>       (a sent turn is answered one step every <ms> and then ends, so UI tests can watch it work)
///
/// Without `-ChroFixture` the app talks to the paired desktop; with it, the app
/// runs on the fixture services (the mock's captured data).
struct LaunchOptions {
    enum Screen: String {
        case list
        case palette
        case home
        case newSessionModel = "new-session-model"
        case onboardingAgent = "onboarding-agent"
        /// New session in the scratch Chats project.
        case newChat = "new-chat"
        /// The focused session's conversation.
        case session
        /// The focused session stopped on its captured rebase conflict.
        case sessionConflict = "session-conflict"
        /// A new session continued from the focused one.
        case continueIn = "continue-in"
        // Right dock and settings (mock slots 8-10, 15-17, 21-24).
        case sourceControl = "source-control"
        case diff
        case file
        case gallery
        case skills
        case settings
        case conflict
        case fileEditing = "file-editing"
        /// The main checkout's hand-made HTML report in the preview.
        case htmlPreview = "html-preview"
        case releaseNotes = "release-notes"
        case errorPage = "error-page"
        case dockFiles = "dock-files"
        case dockSearch = "dock-search"
        case agentStatus = "agent-status"
        case feedback
        /// Open another project > New workspace (mock slot 18).
        case workspacePicker = "workspace-picker"
        /// The dock's Files revealing `docs/skus` (DockContext.revealPath, then New session here).
        case agentDirectory = "agent-directory"
        /// The paired desktops with none active (the list a refused host leads to).
        case hostList = "host-list"
    }

    var fixture: FixtureScenario
    var screen: Screen?
    var focusedSessionID: String?
    var motionScale: Double = 1
    var replyPace: Duration?

    static var current: LaunchOptions {
        let defaults = UserDefaults.standard
        return LaunchOptions(
            fixture: defaults.string(forKey: "ChroFixture").flatMap(FixtureScenario.init(rawValue:)) ?? .standard,
            screen: defaults.string(forKey: "ChroScreen").flatMap(Screen.init(rawValue:)),
            focusedSessionID: defaults.string(forKey: "ChroFocus"),
            motionScale: max(1, defaults.double(forKey: "ChroMotionScale")),
            replyPace: defaults.integer(forKey: "ChroReplyPace") > 0 ? .milliseconds(defaults.integer(forKey: "ChroReplyPace")) : nil
        )
    }
}

/// Where the app's services come from.
enum AppServices {
    /// The one connection to the paired desktop, shared by the shell's services
    /// and the right dock's (`PanelServiceFactory`). Created on first use.
    static let liveWorkspace = LiveWorkspace()

    static func make(_ options: LaunchOptions) -> ChroServiceContainer {
        ProcessInfo.processInfo.arguments.contains("-ChroFixture") ? .fixture(options.fixture, replyPace: options.replyPace) : .live(liveWorkspace)
    }
}
