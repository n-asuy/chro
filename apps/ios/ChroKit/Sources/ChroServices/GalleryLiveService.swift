import ChroAPI
import ChroDomain
import Foundation

/// GalleryService over the paired desktop (lib/project-client.ts
/// `listProjectMedia`, `listTaskRunMedia`, the binary-file URLs).
final class GalleryLiveService: GalleryService, @unchecked Sendable {
    private let calls: PanelLiveCalls

    init(calls: PanelLiveCalls) { self.calls = calls }

    func media(in scope: CheckoutScope, limit: Int) async throws -> MediaListing {
        let data = try await calls.body(.get, try await calls.base(scope) + ["media"], query: ["limit": String(limit)])
        let wire = try calls.decode(Envelope.self, data)
        return MediaListing(items: wire.items.map { item in
            MediaItem(relativePath: item.relativePath, kind: item.kind == "video" ? .video : .image, size: item.size,
                      modifiedAt: item.modifiedAt.flatMap(RFC3339.parse))
        }, truncated: wire.truncated)
    }

    func mediaData(in scope: CheckoutScope, path: String) async throws -> Data {
        try await calls.bytes(try await calls.base(scope) + ["binary-file"], query: ["relative_path": path])
    }

    private struct Envelope: Decodable {
        struct Item: Decodable {
            let relativePath: String
            let kind: String
            let size: Int?
            let modifiedAt: String?
        }

        let items: [Item]
        let truncated: Bool
    }
}
