import SwiftUI

@main
struct ChroMobileApp: App {
    @State private var app: AppModel
    private let launch: LaunchOptions

    init() {
        Typography.registerFonts()
        let launch = LaunchOptions.current
        self.launch = launch
        let app = AppModel(services: AppServices.make(launch))
        app.sheets.motionScale = launch.motionScale
        _app = State(initialValue: app)
    }

    var body: some Scene {
        WindowGroup {
            RootView(app: app, external: ExternalScreens(session: SessionScreen.screen).installingPanels(PanelServiceFactory.make(launch)), launch: launch)
        }
    }
}
