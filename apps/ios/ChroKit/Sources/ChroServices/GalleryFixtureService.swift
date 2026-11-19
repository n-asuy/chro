import ChroDomain
import Foundation

/// GalleryService over the mock's checkouts: the media files the images run
/// created (DockFixtureMedia), in the order the capture listed them.
final class GalleryFixtureService: GalleryService, @unchecked Sendable {
    private let checkouts: DockFixtureCheckouts

    init(checkouts: DockFixtureCheckouts) { self.checkouts = checkouts }

    func media(in scope: CheckoutScope, limit: Int) async throws -> MediaListing {
        let checkout = try checkout(scope)
        let items = checkout.nodes.compactMap { path, node -> MediaItem? in
            guard case .binary(let data, _) = node, let kind = GalleryMedia.kind(forPath: path) else { return nil }
            return MediaItem(relativePath: path, kind: kind, size: data.count, modifiedAt: checkout.modified[path])
        }
        let sorted = GalleryMedia.newestFirst(items)
        return MediaListing(items: Array(sorted.prefix(limit)), truncated: sorted.count > limit)
    }

    func mediaData(in scope: CheckoutScope, path: String) async throws -> Data {
        guard case .binary(let data, _)? = try checkout(scope).nodes[path], GalleryMedia.kind(forPath: path) != nil else {
            throw ServiceError.notFound(path)
        }
        return data
    }

    private func checkout(_ scope: CheckoutScope) throws -> FixtureCheckout {
        guard let checkout = checkouts.checkout(scope) else { throw ServiceError.notFound("Checkout") }
        return checkout
    }
}
