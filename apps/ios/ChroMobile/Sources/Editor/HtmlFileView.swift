import ChroDomain
import ChroServices
import SwiftUI

/// An `.html` / `.htm` file (files-editor.tsx's code layout with the HTML
/// toolbar): Preview renders the page, Raw edits its source in the code editor.
/// While previewing, Refresh preview and Fullscreen preview sit beside the
/// switch; fullscreen gives the header and the page the whole screen. Every
/// switch to the preview and every refresh saves pending edits first, so the
/// page shows what is on disk.
struct HtmlFileView: View {
    let location: FileLocation
    let document: TextDocument
    let metrics: EditorMetrics
    @Environment(\.panelServices) private var services
    @Environment(Router.self) private var router
    @Environment(\.openURL) private var openURL
    @State private var view = HtmlViewState()
    @State private var showsChanges = false
    @State private var find = FindState()

    var body: some View {
        VStack(spacing: 0) {
            if !view.isFullscreen {
                FileNavBar(path: location.path) {
                    if view.mode == .raw {
                        IconButton(icon: .search, size: 19, label: "Find in file") { find.toggle() }
                    } else {
                        NavBarSpacer()
                    }
                }
            }
            FileHeader(path: location.path, showsChanges: document.hasChanges || showsChanges, changesOn: showsChanges,
                       onChanges: { showsChanges.toggle() }) { toolbar }
            switch view.mode {
            case .preview:
                HtmlPreviewView(path: location.path, scope: document.scope, editor: services.editor, reload: view.reload, onLink: open)
            case .raw:
                source
            }
        }
        .animation(nil, value: view.isFullscreen)
    }

    /// The desktop's toolbar minus Annotate (stage 2 of the phone's preview).
    @ViewBuilder private var toolbar: some View {
        HStack(spacing: 0) {
            if view.mode == .preview {
                IconButton(icon: .refreshCw, size: 15, label: "Refresh preview") { saveThen { view.refresh() } }
                IconButton(icon: view.isFullscreen ? .minimize2 : .maximize2, size: 15,
                           label: view.isFullscreen ? "Exit fullscreen" : "Fullscreen preview",
                           tint: view.isFullscreen ? Palette.fg : Palette.t300) { view.toggleFullscreen() }
                    .background(RoundedRectangle(cornerRadius: 6).fill(view.isFullscreen ? Palette.muted : .clear).frame(width: 32, height: 32))
                    .accessibilityAddTraits(view.isFullscreen ? .isSelected : [])
            }
            HeaderToggle(icon: .eye, title: "Preview", isOn: view.mode == .preview) { saveThen { view.show(.preview) } }
                .accessibilityHint("Preview rendered HTML")
            HeaderToggle(icon: .code, title: "Raw", isOn: view.mode == .raw) { view.show(.raw) }
                .accessibilityHint("View raw source")
        }
    }

    /// The code layout's body: the find bar, then the editor or the split diff.
    private var source: some View {
        TextDocumentGate(document: document) {
            VStack(spacing: 0) {
                if find.isOpen {
                    FileFindBar(query: $find.query, counter: find.counter, onPrevious: { find.step(-1) }, onNext: { find.step(1) }, onClose: { find.toggle() })
                }
                if showsChanges, let base = document.baseText {
                    ScrollView { CodeDiffView(path: location.path, old: base, new: document.text, layout: .split) }
                } else {
                    CodeEditor(path: location.path, text: document.text, revision: document.externalRevision, metrics: metrics,
                               decorations: CodeDecorations(changedLines: document.changedLines, focusLine: location.line,
                                                            findQuery: find.isOpen ? find.query : "", currentMatch: find.index),
                               isEditable: document.isEditable,
                               onEdit: { document.edit($0) },
                               onFind: { find.open() },
                               onMatchCount: { find.count = $0 })
                }
            }
        }
    }

    private func saveThen(_ change: @escaping () -> Void) {
        Task {
            await document.flush()
            change()
        }
    }

    /// A file of the checkout opens in chro, in the same checkout; the web and mail go to the system.
    private func open(_ target: PreviewLinkTarget) {
        switch target {
        case .file(let path):
            router.push(.panel(.file(FileLocation(projectID: location.projectID, sessionID: location.sessionID, path: path))))
        case .external(let url):
            openURL(url)
        }
    }
}
