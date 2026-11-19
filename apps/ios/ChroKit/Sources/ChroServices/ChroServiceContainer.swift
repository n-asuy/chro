import Foundation

/// Bundles the services the screens use. `fixture` runs the app on the mock's
/// captured data; the transport supplies the live bundle.
public struct ChroServiceContainer: Sendable {
    public var sessions: any SessionsService
    public var projects: any ProjectsService
    public var uiState: any UIStateService
    public var composer: any ComposerService
    public var onboarding: any OnboardingService
    public var pairing: any PairingService
    public var conversation: any ConversationService

    public init(sessions: any SessionsService, projects: any ProjectsService, uiState: any UIStateService,
                composer: any ComposerService, onboarding: any OnboardingService, pairing: any PairingService,
                conversation: any ConversationService) {
        self.sessions = sessions
        self.projects = projects
        self.uiState = uiState
        self.composer = composer
        self.onboarding = onboarding
        self.pairing = pairing
        self.conversation = conversation
    }

    public static func fixture(_ scenario: FixtureScenario = .standard, replyPace: Duration? = nil) -> ChroServiceContainer {
        let workspace = FixtureWorkspace(scenario: scenario, replyPace: replyPace)
        return ChroServiceContainer(sessions: workspace, projects: workspace, uiState: workspace, composer: workspace,
                                    onboarding: workspace, pairing: workspace, conversation: workspace)
    }
}
