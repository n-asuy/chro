import ChroServices
import SwiftUI

/// Builds the right dock's services the way `AppServices` builds the shell's:
/// the mock's captured data with `-ChroFixture`, else the paired desktop over
/// the same `LiveWorkspace` the shell uses.
enum PanelServiceFactory {
    static func make(_ options: LaunchOptions) -> PanelServices {
        guard ProcessInfo.processInfo.arguments.contains("-ChroFixture") else { return .live(AppServices.liveWorkspace) }
        return .fixture(options.fixture, options: PanelFixtureOptions(failingDiffLoad: options.screen == .errorPage,
                                                                      losingAnswers: ProcessInfo.processInfo.arguments.contains("-ChroLoseAnswers"),
                                                                      previewBridge: PreviewBridgeScripts.suffix))
    }
}

private struct PanelServicesKey: EnvironmentKey {
    static let defaultValue = PanelServices.fixture()
}

extension EnvironmentValues {
    /// The right dock's services, set on every screen this module hands the shell.
    var panelServices: PanelServices {
        get { self[PanelServicesKey.self] }
        set { self[PanelServicesKey.self] = newValue }
    }
}

extension ExternalScreens {
    /// The shell's registry with the right dock, its pushed screens, Settings
    /// and the System sheets filled in.
    func installingPanels(_ services: PanelServices) -> ExternalScreens {
        var screens = self
        screens.dock = { context in AnyView(DockSheet(context: context).environment(\.panelServices, services)) }
        screens.panel = { route in
            AnyView(RouteErrorBoundary { PanelScreen(route: route) }.environment(\.panelServices, services))
        }
        screens.settings = { AnyView(SettingsSheet().environment(\.panelServices, services)) }
        screens.agentStatus = { AnyView(AgentStatusSheet().environment(\.panelServices, services)) }
        screens.feedback = { AnyView(FeedbackSheet().environment(\.panelServices, services)) }
        screens.appVersion = AppVersion.chipLabel
        screens.pathLinks = PathLinks(files: services.files)
        return screens
    }
}

/// The screen of a `PanelRoute`.
private struct PanelScreen: View {
    let route: PanelRoute

    var body: some View {
        switch route {
        case .diff(let sessionID, let path): DiffScreen(sessionID: sessionID, focusPath: path)
        case .file(let location): FileScreen(location: location)
        case .gallery(let projectID, let sessionID): GalleryScreen(projectID: projectID, sessionID: sessionID)
        case .skills(let projectID): SkillsScreen(projectID: projectID)
        case .releaseNotes: ReleaseNotesScreen()
        }
    }
}
