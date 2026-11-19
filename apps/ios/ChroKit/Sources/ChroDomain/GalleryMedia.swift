import Foundation

/// Renderable media the gallery lists (files/media-types.ts).
public enum MediaKind: String, Equatable, Sendable {
    case image, video
}

/// One file of `GET /rpc/projects/:id/media` or `/rpc/task-runs/:id/media`.
public struct MediaItem: Equatable, Sendable, Identifiable, Hashable {
    /// Path relative to the checkout root.
    public var relativePath: String
    public var kind: MediaKind
    public var size: Int?
    public var modifiedAt: Date?

    public init(relativePath: String, kind: MediaKind, size: Int?, modifiedAt: Date?) {
        self.relativePath = relativePath
        self.kind = kind
        self.size = size
        self.modifiedAt = modifiedAt
    }

    public var id: String { relativePath }
    public var name: String { relativePath.split(separator: "/").last.map(String.init) ?? relativePath }
}

/// A media listing; `truncated` when the server capped it at the limit.
public struct MediaListing: Equatable, Sendable {
    public var items: [MediaItem]
    public var truncated: Bool

    public init(items: [MediaItem], truncated: Bool) {
        self.items = items
        self.truncated = truncated
    }
}

/// The gallery's rules (gallery/gallery-panel.tsx and the server's `classify_media`).
public enum GalleryMedia {
    /// The server-side default cap the gallery asks for.
    public static let limit = 2000
    /// Smallest tile edge; columns follow the width.
    public static let minimumTile: Double = 160
    public static let gap: Double = 12

    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico", "tiff", "tif"]
    static let videoExtensions: Set<String> = ["mp4", "webm", "mov", "avi", "mkv", "m4v"]

    public static func kind(forPath path: String) -> MediaKind? {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return nil }
        let ext = name[name.index(after: dot)...].lowercased()
        if imageExtensions.contains(ext) { return .image }
        if videoExtensions.contains(ext) { return .video }
        return nil
    }

    /// Newest modified first; items without a time last; ties by path.
    public static func newestFirst(_ items: [MediaItem]) -> [MediaItem] {
        items.sorted { a, b in
            switch (a.modifiedAt, b.modifiedAt) {
            case let (x?, y?) where x != y: return x > y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.relativePath < b.relativePath
            }
        }
    }

    /// The header count: `N`, or `N+` when the listing was capped.
    public static func countLabel(_ listing: MediaListing) -> String {
        "\(listing.items.count)\(listing.truncated ? "+" : "")"
    }

    public static let truncationNotice = "Showing the \(limit) most recent items. More exist on disk."

    /// Columns that fit `width` with tiles of at least `minimumTile`.
    public static func columns(forWidth width: Double) -> Int {
        guard width > 0 else { return 1 }
        return max(1, Int(((width + gap) / (minimumTile + gap)).rounded(.down)))
    }
}
