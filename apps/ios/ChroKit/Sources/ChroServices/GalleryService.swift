import ChroDomain
import Foundation

/// The media of a project or a run (gallery/gallery-panel.tsx).
public protocol GalleryService: Sendable {
    /// `GET /rpc/projects/:id/media` or `/rpc/task-runs/:id/media?limit=`:
    /// renderable images and videos, newest modified first.
    func media(in scope: CheckoutScope, limit: Int) async throws -> MediaListing
    /// `GET …/binary-file?path=`: a media file's bytes for its tile.
    func mediaData(in scope: CheckoutScope, path: String) async throws -> Data
}
