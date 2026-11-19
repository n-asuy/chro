import SwiftUI
import WebKit

/// Draws SVG markup filling its frame like `object-fit: cover`, without
/// scrolling or interaction (the tile's button takes the tap).
struct VectorImageView: UIViewRepresentable {
    let svg: String

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        return view
    }

    final class Coordinator {
        var loaded: String?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loaded != svg else { return }
        context.coordinator.loaded = svg
        let source = Data(svg.utf8).base64EncodedString()
        let html = """
        <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>html,body{margin:0;height:100%;background:transparent}img{width:100%;height:100%;object-fit:cover;display:block}</style>
        <img src="data:image/svg+xml;base64,\(source)" alt="">
        """
        view.loadHTMLString(html, baseURL: nil)
    }
}
