import ChroAPI
import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// GalleryService over the link: the media listing per scope and the tiles' bytes.
@Suite(.timeLimit(.minutes(1)))
struct LiveGalleryTests {
    let desktop = FakeDesktop()
    static let project = FakeDesktop.panelProject
    static let session = FakeDesktop.panelSession

    @Test func mediaOfARunWithTheLimitAndTheBytes() async throws {
        desktop.runs(Self.session, [FakeDesktop.run("run-1", createdAt: "2026-11-14T08:00:00Z")])
        desktop.reply("GET /rpc/task-runs/run-1/media", ["items": [
            ["relativePath": "docs/images/a.png", "kind": "image", "size": 1050, "modifiedAt": "2026-11-14T09:00:00Z"],
            ["relativePath": "docs/clip.mp4", "kind": "video", "size": NSNull(), "modifiedAt": NSNull()],
        ], "truncated": true])
        desktop.edit { $0.replies["GET /rpc/task-runs/run-1/binary-file"] = .binary(status: 200, contentType: "image/png", Data([9, 8])) }
        let gallery = GalleryLiveService(calls: try await desktop.panelPhone().calls)
        let listing = try await gallery.media(in: .run(sessionID: Self.session), limit: 2000)
        #expect(listing == MediaListing(items: [
            MediaItem(relativePath: "docs/images/a.png", kind: .image, size: 1050, modifiedAt: RFC3339.parse("2026-11-14T09:00:00Z")),
            MediaItem(relativePath: "docs/clip.mp4", kind: .video, size: nil, modifiedAt: nil),
        ], truncated: true))
        #expect(desktop.requests("GET", "/rpc/task-runs/run-1/media").first?.query == ["limit": "2000"])
        #expect(try await gallery.mediaData(in: .run(sessionID: Self.session), path: "docs/images/a.png") == Data([9, 8]))
        #expect(desktop.requests("GET", "/rpc/task-runs/run-1/binary-file").first?.query == ["relative_path": "docs/images/a.png"])
    }

    @Test func projectMediaAndAnSVGAnsweredAsText() async throws {
        desktop.reply("GET /rpc/projects/\(Self.project)/media", ["items": [], "truncated": false])
        desktop.edit { $0.replies["GET /rpc/projects/\(Self.project)/binary-file"] = .text(status: 200, contentType: "text/plain", "<svg/>") }
        let gallery = GalleryLiveService(calls: try await desktop.panelPhone().calls)
        #expect(try await gallery.media(in: .project(id: Self.project), limit: 10) == MediaListing(items: [], truncated: false))
        #expect(try await gallery.mediaData(in: .project(id: Self.project), path: "a.svg") == Data("<svg/>".utf8))
    }

    @Test func aMissingFileIsRefusedWithTheServersText() async throws {
        desktop.edit { $0.failures["/rpc/projects/\(Self.project)/binary-file"] = (404, "File not found") }
        let gallery = GalleryLiveService(calls: try await desktop.panelPhone().calls)
        await #expect(throws: ServiceError.refused("File not found")) { try await gallery.mediaData(in: .project(id: Self.project), path: "gone.png") }
    }
}
