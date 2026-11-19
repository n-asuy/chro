import ChroDomain
import Foundation
import Testing

/// preview-link.test.ts, plus the phone's own addressing of the preview
/// (the URL scheme the web view loads documents and their resources through).
@Suite struct PreviewLinkTests {
    static let origin = "chro-preview://workspace"
    static let assetDirectory = "\(origin)/docs"

    /// A click on a link inside a document served from `assetDirectory`.
    static func click(_ href: String, _ url: String? = nil) -> PreviewLinkMessage {
        let url = url ?? "\(assetDirectory)/\(href)"
        return PreviewLinkMessage(href: href, url: url, local: url.hasPrefix(origin))
    }

    @Test func acceptsAWellFormedBridgeReport() {
        let body: [String: Any] = ["type": "chro:preview-link", "href": "todo.md", "url": "\(Self.assetDirectory)/todo.md", "local": true]
        #expect(PreviewLinkMessage.parse(body) == PreviewLinkMessage(href: "todo.md", url: "\(Self.assetDirectory)/todo.md", local: true))
    }

    /// The preview renders arbitrary project HTML; only the exact shape may reach the file-open path.
    @Test func rejectsForeignOrMalformedMessages() {
        #expect(PreviewLinkMessage.parse(nil) == nil)
        #expect(PreviewLinkMessage.parse("chro:preview-link") == nil)
        #expect(PreviewLinkMessage.parse(["type": "other", "href": "a.md"]) == nil)
        #expect(PreviewLinkMessage.parse(["type": "chro:preview-link", "href": "a.md"]) == nil)
        #expect(PreviewLinkMessage.parse(["type": "chro:preview-link", "href": "a.md", "url": "x", "local": "yes"]) == nil)
        // A JS number 1 bridges to NSNumber, which must not pass for `true`.
        #expect(PreviewLinkMessage.parse(["type": "chro:preview-link", "href": "a.md", "url": "x", "local": NSNumber(value: 1)]) == nil)
    }

    @Test func opensASiblingFileRelativeToTheDocument() {
        #expect(PreviewLinkTarget.resolve(Self.click("todo.md"), documentPath: "docs/index.html") == .file("docs/todo.md"))
    }

    @Test func walksOutOfTheDocumentsDirectory() {
        #expect(PreviewLinkTarget.resolve(Self.click("../notes/todo.md", "\(Self.origin)/notes/todo.md"), documentPath: "docs/index.html")
            == .file("notes/todo.md"))
    }

    @Test func aRootRelativeLinkIsWorkspaceRelative() {
        #expect(PreviewLinkTarget.resolve(Self.click("/README.md", "\(Self.origin)/README.md"), documentPath: "docs/index.html") == .file("README.md"))
    }

    @Test func dropsTheQueryAndFragmentOfAFileLink() {
        #expect(PreviewLinkTarget.resolve(Self.click("todo.md?v=2#section"), documentPath: "docs/index.html") == .file("docs/todo.md"))
    }

    @Test func decodesPercentEncodedSegments() {
        #expect(PreviewLinkTarget.resolve(Self.click("my%20note.md"), documentPath: "docs/index.html") == .file("docs/my note.md"))
    }

    @Test func aRemotePageGoesToTheSystemBrowser() {
        #expect(PreviewLinkTarget.resolve(Self.click("https://example.com/docs", "https://example.com/docs"), documentPath: "docs/index.html")
            == .external(URL(string: "https://example.com/docs")!))
        #expect(PreviewLinkTarget.resolve(Self.click("mailto:a@example.com", "mailto:a@example.com"), documentPath: "docs/index.html")
            == .external(URL(string: "mailto:a@example.com")!))
    }

    /// Handing a script URL to the system opener would turn a previewed document into an execution sink.
    @Test func ignoresNonBrowserSchemes() {
        #expect(PreviewLinkTarget.resolve(Self.click("javascript:alert(1)", "javascript:alert(1)"), documentPath: "docs/index.html") == nil)
        #expect(PreviewLinkTarget.resolve(Self.click("file:///etc/passwd", "file:///etc/passwd"), documentPath: "docs/index.html") == nil)
    }

    /// Same origin but written as a full address: no file path can be recovered without guessing at the route.
    @Test func ignoresASameOriginAbsoluteAddress() {
        #expect(PreviewLinkTarget.resolve(Self.click("\(Self.assetDirectory)/todo.md", "\(Self.assetDirectory)/todo.md"), documentPath: "docs/index.html") == nil)
    }

    @Test func ignoresAnEmptyOrFragmentOnlyHref() {
        #expect(PreviewLinkTarget.resolve(Self.click("  "), documentPath: "docs/index.html") == nil)
        #expect(PreviewLinkTarget.resolve(Self.click("#section"), documentPath: "docs/index.html") == nil)
    }

    @Test func aLinkToTheRootItselfOpensNothing() {
        #expect(PreviewLinkTarget.resolve(Self.click("../..", "\(Self.origin)/"), documentPath: "docs/index.html") == nil)
    }
}

/// embed-path.ts: references resolve in the document's own space.
@Suite struct EmbedPathTests {
    @Test func resolvesAgainstTheDocumentsDirectory() {
        #expect(EmbedPath.resolve(documentPath: "docs/note.md", reference: "img.png") == "docs/img.png")
        #expect(EmbedPath.resolve(documentPath: "note.md", reference: "./img.png") == "img.png")
        #expect(EmbedPath.resolve(documentPath: nil, reference: "a/b.png") == "a/b.png")
    }

    @Test func dotSegmentsCollapseAndCannotClimbAboveTheRoot() {
        #expect(EmbedPath.resolve(documentPath: "docs/a/note.md", reference: "../../x.png") == "x.png")
        #expect(EmbedPath.resolve(documentPath: "docs/note.md", reference: "../../../x.png") == "x.png")
    }

    @Test func aLeadingSlashIsRootRelativeInWorkspaceSpaceAndKeptInAbsoluteSpace() {
        #expect(EmbedPath.resolve(documentPath: "docs/note.md", reference: "/README.md") == "README.md")
        #expect(EmbedPath.resolve(documentPath: "/Users/alice/site/index.html", reference: "todo.md") == "/Users/alice/site/todo.md")
    }
}

/// How the preview addresses a checkout: one host for the shell page that
/// frames the document, one for the files, each URL path a root-relative path.
@Suite struct PreviewAddressTests {
    @Test func theDocumentURLOptsIntoTheBridgeAndCarriesTheReloadCount() throws {
        let url = PreviewAddress.documentURL(path: "docs/stock report.html", reload: 3)
        #expect(url.scheme == "chro-preview")
        #expect(url.host() == "workspace")
        #expect(url.path(percentEncoded: true) == "/docs/stock%20report.html")
        let items = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        #expect(items.contains(URLQueryItem(name: "preview_bridge", value: "1")))
        #expect(items.contains(URLQueryItem(name: "_r", value: "3")))
    }

    @Test func aDocumentURLMapsBackToItsPathAndQuery() {
        let url = PreviewAddress.documentURL(path: "docs/stock report.html", reload: 0)
        #expect(PreviewAddress.request(for: url) == .asset(path: "docs/stock report.html", query: ["preview_bridge": "1", "_r": "0"]))
    }

    @Test func aSubresourceKeepsItsOwnQuery() throws {
        let url = try #require(URL(string: "chro-preview://workspace/docs/stock-report.css?v=2"))
        #expect(PreviewAddress.request(for: url) == .asset(path: "docs/stock-report.css", query: ["v": "2"]))
    }

    @Test func theShellIsItsOwnHost() {
        #expect(PreviewAddress.request(for: PreviewAddress.shellURL) == .shell)
        #expect(PreviewAddress.shellURL.host() != PreviewAddress.documentURL(path: "a.html", reload: 0).host())
    }

    /// The web view resolves `..` before asking, but an encoded dot segment or
    /// separator reaches the handler as written; none of them may leave the root.
    @Test(arguments: [
        "chro-preview://workspace/%2e%2e/secret.txt",
        "chro-preview://workspace/docs/%2E%2E/%2E%2E/etc/passwd",
        "chro-preview://workspace/docs%2F..%2F..%2Fx",
        "chro-preview://workspace/docs//a.css",
        "chro-preview://workspace/docs/",
        "chro-preview://workspace/",
        "chro-preview://workspace/a%00b",
        "chro-preview://elsewhere/docs/a.css",
        "https://workspace/docs/a.css",
    ])
    func addressesOutsideTheCheckoutAreRefused(_ text: String) throws {
        let url = try #require(URL(string: text))
        #expect(PreviewAddress.request(for: url) == .refused)
    }

    @Test func percentEncodedNamesDecode() throws {
        let url = try #require(URL(string: "chro-preview://workspace/docs/%E5%9C%A8%E5%BA%AB.png"))
        #expect(PreviewAddress.request(for: url) == .asset(path: "docs/在庫.png", query: [:]))
    }
}

/// files-editor.tsx's HTML view state: Preview first, fullscreen only over the preview.
@Suite struct HtmlViewStateTests {
    @Test func opensOnThePreview() {
        let state = HtmlViewState()
        #expect(state.mode == .preview)
        #expect(!state.isFullscreen)
    }

    @Test func rawLeavesFullscreen() {
        var state = HtmlViewState()
        state.toggleFullscreen()
        #expect(state.isFullscreen)
        state.show(.raw)
        #expect(state.mode == .raw)
        #expect(!state.isFullscreen)
    }

    @Test func fullscreenOnlyAppliesToThePreview() {
        var state = HtmlViewState()
        state.show(.raw)
        state.toggleFullscreen()
        #expect(!state.isFullscreen)
    }

    @Test func showingThePreviewAndRefreshingReloadTheDocument() {
        var state = HtmlViewState()
        let first = state.reload
        state.refresh()
        #expect(state.reload == first + 1)
        state.show(.raw)
        state.show(.preview)
        #expect(state.reload == first + 2)
    }
}
