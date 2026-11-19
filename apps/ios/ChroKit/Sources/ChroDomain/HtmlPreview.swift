import Foundation

// The HTML preview of the files editor (files-editor.tsx, files/lib/preview-link.ts,
// files/lib/embed-path.ts). The desktop frames the document from the server's asset
// endpoint over http; the phone cannot reach that server, so its web view loads the
// same endpoint through an app-registered URL scheme (`PreviewAddress`).

/// files-editor.tsx `HtmlViewMode`.
public enum HtmlViewMode: Equatable, Sendable {
    case preview, raw
}

/// The HTML toolbar's state: Preview / Raw, the reload count the desktop keys the
/// frame by, and fullscreen, which only exists over the preview.
public struct HtmlViewState: Equatable, Sendable {
    public private(set) var mode: HtmlViewMode = .preview
    public private(set) var reload = 0
    private var fullscreenRequested = false

    public init() {}

    public var isFullscreen: Bool { mode == .preview && fullscreenRequested }

    /// Preview reloads the document (the desktop saves first, then bumps the key); Raw leaves fullscreen.
    public mutating func show(_ mode: HtmlViewMode) {
        self.mode = mode
        switch mode {
        case .preview: reload += 1
        case .raw: fullscreenRequested = false
        }
    }

    /// "Refresh preview".
    public mutating func refresh() { reload += 1 }

    /// "Fullscreen preview" / "Exit fullscreen".
    public mutating func toggleFullscreen() {
        guard mode == .preview else { return }
        fullscreenRequested.toggle()
    }
}

/// embed-path.ts `resolveEmbedPath`: a reference written inside the document at
/// `documentPath`, resolved in that document's space (workspace-relative, or
/// host-absolute when the document itself is).
public enum EmbedPath {
    public static func resolve(documentPath: String?, reference: String) -> String {
        let absoluteSpace = documentPath?.hasPrefix("/") ?? false
        let joined: String
        if reference.hasPrefix("/") {
            joined = reference
        } else {
            let directory = documentPath.map(FilePath.directory) ?? ""
            joined = directory.isEmpty ? reference : directory + "/" + reference
        }
        var segments: [Substring] = []
        for segment in joined.split(separator: "/", omittingEmptySubsequences: true) {
            if segment == ".." { _ = segments.popLast() } else if segment != "." { segments.append(segment) }
        }
        let normalized = segments.joined(separator: "/")
        return absoluteSpace ? "/" + normalized : normalized
    }
}

/// A link click the preview bridge reported (`chro:preview-link`, the server's
/// `preview_link_bridge.js`).
public struct PreviewLinkMessage: Equatable, Sendable {
    public static let type = "chro:preview-link"

    /// The `href` attribute exactly as written.
    public var href: String
    /// `href` resolved against the document's URL.
    public var url: String
    /// Served by the same asset endpoint as the document: a file of the checkout.
    public var local: Bool

    public init(href: String, url: String, local: Bool) {
        self.href = href
        self.url = url
        self.local = local
    }

    /// The exact shape or nothing: the preview runs arbitrary project HTML,
    /// which may post its own messages.
    public static func parse(_ body: Any?) -> PreviewLinkMessage? {
        guard let object = body as? [String: Any], object["type"] as? String == type,
              let href = object["href"] as? String, let url = object["url"] as? String,
              let local = object["local"] as? NSNumber, CFGetTypeID(local) == CFBooleanGetTypeID()
        else { return nil }
        return PreviewLinkMessage(href: href, url: url, local: local.boolValue)
    }
}

/// What a forwarded click opens (preview-link.ts `resolvePreviewLinkTarget`).
public enum PreviewLinkTarget: Equatable, Sendable {
    /// A file of the checkout, root-relative.
    case file(String)
    /// A web page or mail address, for the system.
    case external(URL)

    private static let externalSchemes: Set<String> = ["http", "https", "mailto"]

    /// nil when the click has no action (the bridge already kept the frame where it was).
    public static func resolve(_ message: PreviewLinkMessage, documentPath: String?) -> PreviewLinkTarget? {
        let href = message.href.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !href.isEmpty, !href.hasPrefix("#") else { return nil }

        guard message.local else {
            guard let url = URL(string: message.url), let scheme = url.scheme?.lowercased(), externalSchemes.contains(scheme) else { return nil }
            return .external(url)
        }
        // Same endpoint, yet written as a full address: it names a route of the
        // endpoint, from which no file path can be recovered.
        guard href.range(of: #"^(?:[a-zA-Z][a-zA-Z\d+\-.]*:|//)"#, options: .regularExpression) == nil else { return nil }
        let withoutFragment = href.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let pathPart = withoutFragment.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        guard !pathPart.isEmpty else { return nil }
        let decoded = pathPart.split(separator: "/", omittingEmptySubsequences: false)
            .map { String($0).removingPercentEncoding ?? String($0) }
            .joined(separator: "/")
        let path = EmbedPath.resolve(documentPath: documentPath, reference: decoded)
        guard !path.isEmpty, path != "/" else { return nil }
        return .file(path)
    }
}

/// The URLs the phone's preview loads. `chro-preview://shell/` is the app's page
/// that frames the document the way the desktop's editor does (the bridge talks to
/// its parent window); `chro-preview://workspace/<root-relative path>` is the
/// checkout's asset endpoint, so relative references in the document resolve to
/// sibling files exactly as they do on the desktop.
public enum PreviewAddress {
    public static let scheme = "chro-preview"
    static let shellHost = "shell"
    static let workspaceHost = "workspace"
    /// files/lib/preview-link.ts `PREVIEW_BRIDGE_PARAM`.
    public static let bridgeParameter = "preview_bridge"

    public static var shellURL: URL { URL(string: "\(scheme)://\(shellHost)/")! }

    /// The framed document: opted into the bridge, keyed by the reload count (the desktop's `_r`).
    public static func documentURL(path: String, reload: Int) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = workspaceHost
        components.percentEncodedPath = assetPath(path)
        components.queryItems = [URLQueryItem(name: "_r", value: String(reload)), URLQueryItem(name: bridgeParameter, value: "1")]
        return components.url!
    }

    public enum Request: Equatable, Sendable {
        case shell
        /// A file of the checkout and the query the document asked with.
        case asset(path: String, query: [String: String])
        /// Not an address of this preview, or one that would leave the checkout.
        case refused
    }

    public static func request(for url: URL) -> Request {
        guard url.scheme?.lowercased() == scheme, let host = url.host(percentEncoded: true)?.lowercased() else { return .refused }
        let encodedPath = url.path(percentEncoded: true)
        if host == shellHost { return encodedPath.isEmpty || encodedPath == "/" ? .shell : .refused }
        guard host == workspaceHost, encodedPath.hasPrefix("/") else { return .refused }
        var segments: [String] = []
        for raw in encodedPath.dropFirst().split(separator: "/", omittingEmptySubsequences: false) {
            guard let segment = String(raw).removingPercentEncoding, !segment.isEmpty, segment != ".", segment != "..",
                  !segment.contains("/"), !segment.contains("\u{0}")
            else { return .refused }
            segments.append(segment)
        }
        guard !segments.isEmpty else { return .refused }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let query = items.reduce(into: [String: String]()) { $0[$1.name] = $1.value ?? "" }
        return .asset(path: segments.joined(separator: "/"), query: query)
    }

    private static func assetPath(_ path: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#;")
        return path.split(separator: "/", omittingEmptySubsequences: false)
            .map { "/" + (String($0).addingPercentEncoding(withAllowedCharacters: allowed) ?? String($0)) }
            .joined()
    }
}
