import ChroServices
import SwiftUI

/// Where the Files, Search and Agent panels lead: a pushed file, the
/// gallery, a session, or back to the dock after one of their sheets.
@MainActor
struct FilesNavigator {
    let context: DockContext
    let sheets: SheetPresenter
    let router: Router
    let external: ExternalScreens
    let services: PanelServices

    /// Closes the dock and pushes the file (files-store `openFile`, `requestEditorReveal`).
    func openFile(_ path: String, line: Int? = nil) {
        sheets.dismiss()
        router.push(.panel(.file(FileLocation(projectID: context.projectID, sessionID: context.sessionID, path: path, line: line))))
    }

    func openGallery() {
        sheets.dismiss()
        router.push(.panel(.gallery(projectID: context.projectID, sessionID: context.sessionID)))
    }

    /// A sheet's Done or Cancel: the dock comes back on Files.
    func returnToDock() {
        guard let dock = external.dock else { sheets.dismiss(); return }
        let files = DockContext(projectID: context.projectID, sessionID: context.sessionID, panel: .files)
        sheets.present(tall: true) { dock(files) }
    }

    /// Presents one of the panels' own sheets with the dock's services.
    func present<Content: View>(tall: Bool = false, @ViewBuilder _ content: () -> Content) {
        let services = services
        sheets.present(tall: tall) { content().environment(\.panelServices, services) }
    }
}
