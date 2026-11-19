import ChroDomain
import ChroServices
import SwiftUI

/// A file opened from Files, Search, the diff, the gallery or a note link
/// (files-editor.tsx as a pushed screen): the viewer its extension picks,
/// reading the checkout of `location` (a session's worktree or the main
/// checkout).
struct FileScreen: View {
    let location: FileLocation
    @Environment(WorkspaceStore.self) private var store

    var body: some View {
        let scope = store.checkoutScope(projectID: location.projectID, sessionID: location.sessionID)
        Group {
            switch FileViewerKind(path: location.path) {
            case .image: ImageFileScreen(location: location, scope: scope)
            case .pdf: PDFFileScreen(location: location, scope: scope)
            case .video, .audio: MediaFileScreen(location: location, scope: scope)
            case .scene: SceneFileScreen(location: location, scope: scope)
            case .csv, .base, .prose, .html, .code: TextFileScreen(location: location, scope: scope)
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }
}

/// The text kinds share one document: the code layout, the prose layout,
/// the HTML preview and source, the spreadsheet and the `.cbase` view.
private struct TextFileScreen: View {
    let location: FileLocation
    let scope: CheckoutScope
    @Environment(\.panelServices) private var services
    @Environment(\.reportRouteFailure) private var reportFailure
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AppStorage(DeviceSettingKey.editorFontSize) private var fontSize = EditorChoices.defaultFontSize
    @State private var document: TextDocument?
    @State private var lineHeight = EditorChoices.defaultLineHeight

    var body: some View {
        Group {
            if let document {
                content(document)
            } else {
                Color.clear
            }
        }
        .task(id: location) {
            let document = TextDocument(path: location.path, scope: scope, editor: services.editor, sourceControl: services.sourceControl)
            document.onSaveError = { message in
                toasts.show("Failed to save file “\(location.path)”",
                            description: "\(message). Make a backup of the contents of this file now to avoid losing data.")
            }
            document.onMerged = { toasts.show("“\(location.path)” has been modified externally, merging changes automatically.") }
            document.onUnexpected = { reportFailure(RouteFailure($0)) }
            self.document = document
            if let height = try? await services.settings.editorLineHeight() { lineHeight = height }
            await document.run()
        }
        .onDisappear { if let document { Task { await document.flush() } } }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active, let document { Task { await document.flush() } }
        }
    }

    /// The editor's font size setting at the reader's Dynamic Type size.
    private var metrics: EditorMetrics {
        EditorMetrics(fontSize: (CGFloat(fontSize) * Typography.scale(dynamicTypeSize)).rounded(), lineHeight: CGFloat(lineHeight))
    }

    @ViewBuilder private func content(_ document: TextDocument) -> some View {
        switch FileViewerKind(path: location.path) {
        case .prose: ProseFileView(location: location, document: document, metrics: metrics)
        case .csv: CSVFileView(location: location, document: document)
        case .base: BaseFileView(location: location, document: document)
        case .html: HtmlFileView(location: location, document: document, metrics: metrics)
        default: CodeFileView(location: location, document: document, metrics: metrics)
        }
    }
}

/// `.navbar` of a file: back, the file name, one trailing action (or the 44pt spacer).
struct FileNavBar<Trailing: View>: View {
    let path: String
    @ViewBuilder var trailing: () -> Trailing
    @Environment(Router.self) private var router

    var body: some View {
        NavBar(title: FilePath.name(path), onBack: { router.pop() }) {
            trailing()
        }
    }
}

/// The navbar's empty right slot, so the title stays centred.
struct NavBarSpacer: View {
    var body: some View { Color.clear.frame(width: 44, height: 44) }
}

extension FileNavBar where Trailing == NavBarSpacer {
    init(path: String) {
        self.init(path: path) { NavBarSpacer() }
    }
}

/// Loading, the server's error, or the large-file preview of a text document.
struct TextDocumentGate<Content: View>: View {
    let document: TextDocument
    @ViewBuilder var content: () -> Content

    var body: some View {
        switch document.phase {
        case .loading: EditorStatus(text: "Loading file…")
        case .failed(let message): EditorStatus(text: message)
        case .ready:
            if document.truncated {
                VStack(spacing: 0) {
                    LargeFileNotice(size: document.size)
                    ScrollView([.horizontal, .vertical]) {
                        Text(document.text)
                            .textStyle(.code(12))
                            .lineSpacing(8)
                            .foregroundStyle(Palette.t200)
                            .padding(16)
                            .textSelection(.enabled)
                    }
                }
            } else {
                content()
            }
        }
    }
}
