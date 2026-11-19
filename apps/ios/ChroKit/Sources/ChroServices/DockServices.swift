import Foundation

/// The services of the right dock and the screens it leads to (Files,
/// Search, Agent, Source Control, Diff, the editor and viewers, Gallery,
/// Skills, Settings, Agent status, Feedback). Kept apart from
/// `ChroServiceContainer` so the right-dock module plugs into the shell only
/// through `ExternalScreens` (mobile architecture §14).
public struct PanelServices: Sendable {
    public var files: any FilesService
    public var sourceControl: any SourceControlService
    public var editor: any EditorService
    public var gallery: any GalleryService
    public var skills: any SkillsService
    public var settings: any SettingsService
    public var system: any SystemService

    public init(files: any FilesService, sourceControl: any SourceControlService, editor: any EditorService,
                gallery: any GalleryService, skills: any SkillsService, settings: any SettingsService, system: any SystemService) {
        self.files = files
        self.sourceControl = sourceControl
        self.editor = editor
        self.gallery = gallery
        self.skills = skills
        self.settings = settings
        self.system = system
    }

    /// The mock's captured data. One set of checkouts backs every service, so
    /// a save in the editor shows in Files, Search, Source Control and Diff.
    public static func fixture(_ scenario: FixtureScenario = .standard, options: PanelFixtureOptions = PanelFixtureOptions()) -> PanelServices {
        let checkouts = DockFixtureCheckouts()
        let sourceControl = SourceControlFixtureService(checkouts: checkouts, options: options)
        let settings = SettingsFixtureService(scenario: scenario)
        return PanelServices(
            files: FilesFixtureService(checkouts: checkouts),
            sourceControl: options.losingAnswers ? LostAnswerSourceControl(base: sourceControl) : sourceControl,
            editor: EditorFixtureService(checkouts: checkouts, previewBridge: options.previewBridge),
            gallery: GalleryFixtureService(checkouts: checkouts),
            skills: SkillsFixtureService(scenario: scenario),
            settings: options.losingAnswers ? LostAnswerSettings(base: settings) : settings,
            system: SystemFixtureService(scenario: scenario)
        )
    }
}

extension PanelServices {
    /// The paired desktop, through the app's `LiveWorkspace` (one link, one view
    /// of the desktop's sessions for the shell and the panels). Feedback goes to
    /// the cloud API the desktop posts to, with the app's version.
    public static func live(_ workspace: LiveWorkspace) -> PanelServices {
        let calls = PanelLiveCalls(workspace: workspace)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return PanelServices(
            files: FilesLiveService(calls: calls),
            sourceControl: SourceControlLiveService(calls: calls),
            editor: EditorLiveService(workspace: workspace),
            gallery: GalleryLiveService(calls: calls),
            skills: SkillsLiveService(calls: calls),
            settings: SettingsLiveService(calls: calls),
            system: SystemLiveService(calls: calls, feedback: CloudFeedbackSender(appVersion: version))
        )
    }
}

/// Faults the fixture can inject, to reach failure screens on the simulator.
public struct PanelFixtureOptions: Sendable, Equatable {
    /// Every diff load fails with an unexpected error (mock slot 24, the route error page).
    public var failingDiffLoad: Bool
    /// Every Source Control change and settings save takes effect, then its answer is lost.
    public var losingAnswers: Bool
    /// The scripts the server appends to the HTML preview's document (the app bundles
    /// the server's own files, so the fixture's preview runs the real bridge).
    public var previewBridge: String

    public init(failingDiffLoad: Bool = false, losingAnswers: Bool = false, previewBridge: String = "") {
        self.failingDiffLoad = failingDiffLoad
        self.losingAnswers = losingAnswers
        self.previewBridge = previewBridge
    }
}
