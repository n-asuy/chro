import ChroDomain
import ChroServices
import SwiftUI
import UIKit

/// The app's root: pairing, host choice, onboarding or the workspace, with
/// the shared sheet and toast layers above all of them.
struct RootView: View {
    @Bindable var app: AppModel
    let external: ExternalScreens
    let launch: LaunchOptions
    @AppStorage(ThemeChoice.storageKey) private var theme = ThemeChoice.system.rawValue

    var body: some View {
        ToastHost(center: app.toasts) {
            SheetHost(presenter: app.sheets) {
                content
                    .fullScreenCover(item: $app.linkPairing) { model in
                        PairingScreen(model: model, onBack: { app.linkPairing = nil }) { _ in app.linkPairing = nil }
                            .environment(app.sheets)
                            .environment(app.toasts)
                    }
            }
        }
        .environment(app.workspace)
        .environment(app.router)
        .environment(app.drafts)
        .environment(\.externalScreens, external)
        .preferredColorScheme(ThemeChoice(rawValue: theme)?.colorScheme)
        .dynamicTypeSize(...Typography.maximumDynamicTypeSize)
        .tint(Palette.primary)
        .onOpenURL { app.handle(url: $0) }
        .task {
            app.start()
            if launch.screen == .hostList { await app.services.pairing.activate(hostID: nil) }
        }
    }

    @ViewBuilder private var content: some View {
        switch app.phase {
        case .loading:
            Palette.bg.ignoresSafeArea()
        case .pairing:
            PairingScreen(model: PairingModel(service: app.services.pairing),
                          onBack: app.pairing?.hosts.isEmpty == false ? { app.isAddingHost = false } : nil) { _ in }
                .id(app.isAddingHost)
        case .hostList:
            HostListScreen(state: app.pairing!, service: app.services.pairing) { app.isAddingHost = true }
        case .onboarding:
            OnboardingFlow(services: app.services, startAt: launch.screen == .onboardingAgent ? .agent : nil) { landing in
                app.finishOnboarding(landing: landing)
            }
        case .workspace:
            let refused = app.pairing.flatMap { state in
                state.connection == .authFailed || state.connection == .incompatible ? state.activeHost.map { ($0, state.connection) } : nil
            }
            WorkspaceShell(launch: launch)
                .allowsHitTesting(refused == nil)
                .overlay(alignment: .top) {
                    if let (host, connection) = refused {
                        HostRefusedBanner(
                            host: host, connection: connection,
                            onRetry: { Task { await app.services.pairing.reconnect() } },
                            onPairAgain: { Task { await app.services.pairing.activate(hostID: nil); app.isAddingHost = true } },
                            onRemove: { Task { await app.services.pairing.remove(hostID: host.id) } }
                        )
                        .padding(.top, 4)
                    }
                }
        }
    }
}

extension PairingModel: Identifiable {
    nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }
}

/// The left panel as the navigation root, with Home, New session, the
/// session screen and the folder picker pushed above it.
struct WorkspaceShell: View {
    let launch: LaunchOptions
    @Environment(WorkspaceStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ComposerDrafts.self) private var drafts
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.externalScreens) private var external
    @State private var appliedLaunchScreen = false

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.path) {
            Group {
                if store.isLoaded && store.projects.openProjects.isEmpty {
                    FirstLaunchView()
                } else {
                    SessionListScreen()
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Route.self) { route in
                destination(route).toolbar(.hidden, for: .navigationBar)
            }
        }
        .onChange(of: store.isLoaded) { _, loaded in if loaded { applyLaunchScreen() } }
        .onAppear { if store.isLoaded { applyLaunchScreen() } }
    }

    @ViewBuilder private func destination(_ route: Route) -> some View {
        switch route {
        case .home(let projectID): ProjectLauncherScreen(projectID: projectID, kind: .home)
        case .newSession(let projectID, let homeDir): ProjectLauncherScreen(projectID: projectID, kind: .newSession, homeDir: homeDir)
        case .session(let id): external.session?(id)
        case .folderPicker:
            FolderPickerScreen(onCancel: { router.pop() }) { project in router.reset(to: [.home(projectID: project.id)]) }
        case .panel(let route): external.panel?(route)
        }
    }

    /// Opens the state a screenshot needs (LaunchOptions.Screen), once.
    private func applyLaunchScreen() {
        guard !appliedLaunchScreen else { return }
        let screen = launch.screen ?? .list
        appliedLaunchScreen = true
        if let focus = launch.focusedSessionID { store.focusedSessionID = focus }
        let project = store.projects.openProjects.first?.id
        switch screen {
        case .list, .onboardingAgent, .hostList: break
        case .palette: sheets.present(tall: true) { SearchPaletteSheet() }
        case .home: if let project { router.reset(to: [.home(projectID: project)]) }
        case .newSessionModel:
            guard let project else { return }
            router.reset(to: [.newSession(projectID: project)])
            let model = drafts.model(projectID: project, isScratch: false, services: store.services)
            Task {
                await model.load()
                sheets.present { ModelSheet(model: model) }
            }
        case .newChat:
            store.openScratchChat(toasts: toasts) { router.reset(to: [.newSession(projectID: $0)]) }
        case .session, .sessionConflict:
            guard let focus = launch.focusedSessionID else { return }
            if screen == .sessionConflict { (store.services.conversation as? FixtureWorkspace)?.enterCapturedConflict(sessionID: focus) }
            router.reset(to: [.session(id: focus)])
        case .continueIn:
            guard let focus = launch.focusedSessionID else { return }
            Task {
                guard let continued = try? await store.services.sessions.continueSession(sessionID: focus, in: .sameCheckout) else { return }
                store.focusedSessionID = continued.id
                router.reset(to: [.session(id: continued.id)])
            }
        default:
            applyPanelLaunchScreen(screen, project: project)
        }
    }

    /// The right dock's and settings' states, as the mock's slots stack them.
    private func applyPanelLaunchScreen(_ screen: LaunchOptions.Screen, project: String?) {
        guard let project else { return }
        let added = "7a3f5d10-add", images = "bd50a1e2-img", reworded = "c4534455-rw"
        func session(_ id: String) -> [Route] {
            store.focusedSessionID = id
            return external.session != nil ? [.session(id: id)] : []
        }
        func dock(_ sessionID: String?, _ panel: DockContext.Panel) {
            guard let dock = external.dock else { return }
            sheets.present(tall: true) { dock(DockContext(projectID: project, sessionID: sessionID, panel: panel)) }
        }
        func sheet(_ content: (@MainActor @Sendable () -> AnyView)?, tall: Bool) {
            guard let content else { return }
            sheets.present(tall: tall) { content() }
        }
        switch screen {
        case .sourceControl:
            router.reset(to: session(added))
            dock(added, .sourceControl)
        case .conflict:
            router.reset(to: session(reworded))
            dock(reworded, .sourceControl)
        case .dockFiles:
            router.reset(to: session(added))
            dock(added, .files)
        case .dockSearch:
            router.reset(to: [.home(projectID: project)])
            dock(nil, .searchFiles)
        case .diff, .errorPage:
            // error-page: the panel services are built with the diff load failing (PanelServices.make).
            router.reset(to: session(added) + [.panel(.diff(sessionID: added, path: "src/stock.ts"))])
        case .file:
            router.reset(to: session(added) + [.panel(.file(FileLocation(projectID: project, sessionID: added, path: "src/stock.ts")))])
        case .gallery:
            router.reset(to: session(images) + [.panel(.gallery(projectID: project, sessionID: images))])
        case .skills:
            router.reset(to: [.home(projectID: project), .panel(.skills(projectID: project))])
        case .fileEditing:
            router.reset(to: [.home(projectID: project), .panel(.file(FileLocation(projectID: project, path: "README.md")))])
        case .htmlPreview:
            router.reset(to: [.home(projectID: project), .panel(.file(FileLocation(projectID: project, path: "docs/report/index.html")))])
        case .releaseNotes:
            router.reset(to: [.panel(.releaseNotes)])
        case .settings: sheet(external.settings, tall: true)
        case .agentStatus: sheet(external.agentStatus, tall: false)
        case .feedback: sheet(external.feedback, tall: false)
        case .workspacePicker:
            router.reset(to: [.folderPicker(.openProject)])
        case .agentDirectory:
            router.reset(to: [.home(projectID: project)])
            guard let dock = external.dock else { return }
            sheets.present(tall: true) { dock(DockContext(projectID: project, sessionID: nil, panel: .files, revealPath: "docs/skus")) }
        case .list, .palette, .home, .newSessionModel, .onboardingAgent,
             .newChat, .session, .sessionConflict, .continueIn, .hostList: break
        }
    }
}

/// routes/index.tsx with no workspace open.
struct FirstLaunchView: View {
    @Environment(Router.self) private var router

    var body: some View {
        VStack(spacing: 0) {
            ChroSymbol(size: 48).accessibilityHidden(true)
            Text("Open a workspace").textStyle(TextStyle(size: 16, weight: 500)).foregroundStyle(Palette.fg).padding(.top, 14)
            Text("Choose a folder to start working in Chro.").textStyle(TextStyle(size: 14)).foregroundStyle(Palette.t300).padding(.top, 6)
            BigButton(title: "Open folder", icon: .folderOpen) { router.push(.folderPicker(.openProject)) }
                .padding(.top, 22)
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.bg.ignoresSafeArea())
    }
}

/// Keeps the edge-swipe back gesture while the system navigation bar is hidden.
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }

    /// Screens with their own pans (a zoomable image, a wide table) wait for the edge
    /// swipe to fail, so going back still works from the screen's left edge.
    public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                                  shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        gestureRecognizer == interactivePopGestureRecognizer
    }
}
