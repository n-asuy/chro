import ChroDomain
import Foundation
import Testing

@Suite struct GalleryMediaTests {
    private func item(_ path: String, _ modified: TimeInterval?) -> MediaItem {
        MediaItem(relativePath: path, kind: .image, size: nil, modifiedAt: modified.map { Date(timeIntervalSince1970: $0) })
    }

    @Test func classifiesByExtensionLikeTheServer() {
        #expect(GalleryMedia.kind(forPath: "docs/images/a.PNG") == .image)
        #expect(GalleryMedia.kind(forPath: "b.svg") == .image)
        #expect(GalleryMedia.kind(forPath: "clip.mov") == .video)
        #expect(GalleryMedia.kind(forPath: "notes.md") == nil)
        #expect(GalleryMedia.kind(forPath: "README") == nil)
        #expect(GalleryMedia.kind(forPath: "song.mp3") == nil)
    }

    @Test func ordersNewestModifiedFirstWithUndatedLast() {
        let sorted = GalleryMedia.newestFirst([item("old.png", 10), item("none.png", nil), item("new.png", 30), item("b.png", 20), item("a.png", 20)])
        #expect(sorted.map(\.relativePath) == ["new.png", "a.png", "b.png", "old.png", "none.png"])
    }

    @Test func countShowsAPlusWhenTruncated() {
        #expect(GalleryMedia.countLabel(MediaListing(items: [item("a.png", 1)], truncated: false)) == "1")
        #expect(GalleryMedia.countLabel(MediaListing(items: [item("a.png", 1), item("b.png", 2)], truncated: true)) == "2+")
    }

    @Test func truncationNoticeNamesTheLimit() {
        #expect(GalleryMedia.truncationNotice == "Showing the 2000 most recent items. More exist on disk.")
    }

    @Test func columnsFollowTheWidthWithA160PointMinimumTile() {
        #expect(GalleryMedia.columns(forWidth: 370) == 2)
        #expect(GalleryMedia.columns(forWidth: 150) == 1)
        #expect(GalleryMedia.columns(forWidth: 0) == 1)
        #expect(GalleryMedia.columns(forWidth: 700) == 4)
    }

    @Test func fileNameIsTheLastSegment() {
        #expect(item("docs/images/sku-heatmap.png", nil).name == "sku-heatmap.png")
    }
}
