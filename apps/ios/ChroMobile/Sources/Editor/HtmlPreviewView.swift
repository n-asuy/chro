import ChroDomain
import ChroServices
import SwiftUI
import WebKit

/// The rendered HTML of a file (files-editor.tsx's preview iframe). The desktop
/// frames `…/asset/<path>?preview_bridge=1` from its local server; the phone
/// cannot reach that server, so a `WKURLSchemeHandler` answers every request of
/// the page (the document, its stylesheets, scripts, images and fonts) from the
/// same asset endpoint over the link. The page is framed the same way, inside
/// an app page that relays the server's link bridge to the app, with the
/// desktop's sandbox flags and a data store that keeps nothing.
struct HtmlPreviewView: UIViewRepresentable {
    let path: String
    let scope: CheckoutScope
    let editor: any EditorService
    /// The desktop's `_r`: a new value loads the document again.
    let reload: Int
    let onLink: (PreviewLinkTarget) -> Void

    /// The name the page posts link reports under.
    static let messageName = "previewLink"

    func makeCoordinator() -> Coordinator { Coordinator(onLink: onLink) }

    func makeUIView(context: Context) -> WKWebView {
        let coordinator = context.coordinator
        coordinator.onLink = onLink
        coordinator.documentPath = path
        let handler = PreviewSchemeHandler(editor: editor, scope: scope) { [weak coordinator] in
            PreviewShell.html(document: PreviewAddress.documentURL(path: coordinator?.documentPath ?? path, reload: coordinator?.loadedReload ?? reload),
                              title: FilePath.name(coordinator?.documentPath ?? path))
        }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(handler, forURLScheme: PreviewAddress.scheme)
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(WeakMessageHandler(coordinator), name: Self.messageName)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        webView.isOpaque = false
        webView.backgroundColor = .white
        webView.accessibilityIdentifier = "html-preview"
        coordinator.handler = handler
        coordinator.load(webView, reload: reload)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onLink = onLink
        coordinator.documentPath = path
        if coordinator.loadedReload != reload { coordinator.load(webView, reload: reload) }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: messageName)
        coordinator.handler?.cancelAll()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var onLink: (PreviewLinkTarget) -> Void
        var documentPath = ""
        var handler: PreviewSchemeHandler?
        private(set) var loadedReload: Int?

        init(onLink: @escaping (PreviewLinkTarget) -> Void) { self.onLink = onLink }

        func load(_ webView: WKWebView, reload: Int) {
            loadedReload = reload
            webView.load(URLRequest(url: PreviewAddress.shellURL))
        }

        /// The bridge's report, relayed by the app page (the main frame) only:
        /// a previewed document could post to the handler directly, so the frame
        /// that sent it is checked as well as the message's shape.
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame,
                  PreviewAddress.request(for: message.frameInfo.request.url ?? URL(fileURLWithPath: "/")) == .shell,
                  let report = PreviewLinkMessage.parse(message.body),
                  let target = PreviewLinkTarget.resolve(report, documentPath: documentPath)
            else { return }
            onLink(target)
        }

        /// The app page is the only top-level document. The framed document may
        /// navigate itself (as the desktop's frame may); it cannot replace the page.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard action.targetFrame?.isMainFrame ?? true else { return .allow }
            guard let url = action.request.url else { return .cancel }
            return PreviewAddress.request(for: url) == .shell ? .allow : .cancel
        }

        /// No new windows (`target=_blank` links are reported by the bridge instead).
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    }
}

/// `WKUserContentController` keeps its handlers strongly; this keeps the
/// coordinator (and through it the screen's closures) out of that cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// The app page that frames the document: the desktop's iframe and sandbox
/// flags, and a relay of the bridge's `postMessage` from that frame (and only
/// that frame) to the app.
enum PreviewShell {
    static func html(document: URL, title: String) -> String {
        """
        <!doctype html>
        <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style>
        </head><body>
        <iframe title="\(escape(title))" src="\(escape(document.absoluteString))" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
        <script>
        (function () {
          var frame = document.querySelector("iframe");
          window.addEventListener("message", function (event) {
            if (event.source !== frame.contentWindow) return;
            window.webkit.messageHandlers.\(HtmlPreviewView.messageName).postMessage(event.data);
          });
        })();
        </script>
        </body></html>
        """
    }

    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
}

/// Answers the preview's `chro-preview:` requests: the app page, and every file
/// of the checkout through the asset endpoint (`EditorService.readAsset`).
/// Addresses that would leave the checkout are refused before any request.
@MainActor
final class PreviewSchemeHandler: NSObject, WKURLSchemeHandler {
    private let editor: any EditorService
    private let scope: CheckoutScope
    private let shell: @MainActor () -> String
    private var running: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(editor: any EditorService, scope: CheckoutScope, shell: @escaping @MainActor () -> String) {
        self.editor = editor
        self.scope = scope
        self.shell = shell
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        switch PreviewAddress.request(for: url) {
        case .shell:
            Self.respond(task, url: url, status: 200, contentType: "text/html; charset=utf-8", data: Data(shell().utf8))
        case .refused:
            // The server's own words for a path that leaves the workspace root.
            Self.respond(task, url: url, status: 400, contentType: "text/plain; charset=utf-8", data: Data("path is outside the workspace root".utf8))
        case .asset(let path, let query):
            let id = ObjectIdentifier(task)
            running[id] = Task { [editor, scope] in
                let answer: AssetResponse
                do {
                    answer = try await editor.readAsset(path, query: query, in: scope)
                } catch {
                    let text = (error as? EditorError)?.message ?? error.localizedDescription
                    answer = AssetResponse(status: 502, contentType: "text/plain; charset=utf-8", data: Data(text.utf8))
                }
                // A stopped task must not be answered (WebKit raises).
                guard !Task.isCancelled, self.running.removeValue(forKey: id) != nil else { return }
                Self.respond(task, url: url, status: answer.status, contentType: answer.contentType, data: answer.data)
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        running.removeValue(forKey: ObjectIdentifier(task))?.cancel()
    }

    func cancelAll() {
        running.values.forEach { $0.cancel() }
        running.removeAll()
    }

    private static func respond(_ task: any WKURLSchemeTask, url: URL, status: Int, contentType: String, data: Data) {
        let headers = ["Content-Type": contentType, "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }
}

/// The scripts the server appends to an opted-in document
/// (`PREVIEW_BRIDGE_SUFFIX`, crates/server asset_response.rs), read from the
/// server's own files bundled with the app, for the fixture services.
enum PreviewBridgeScripts {
    static var suffix: String {
        let scripts = ["preview_link_bridge", "preview_annotation_overlay"].compactMap { name in
            Bundle.main.url(forResource: name, withExtension: "js").flatMap { try? String(contentsOf: $0, encoding: .utf8) }
        }
        return scripts.map { "\n<script>\n" + $0 + "</script>" }.joined() + (scripts.isEmpty ? "" : "\n")
    }
}
