import ChroDomain
import Testing

@Suite struct FileViewerKindTests {
    @Test(arguments: [
        ("docs/images/a.PNG", FileViewerKind.image), ("b.svg", .image), ("c.webp", .image),
        ("docs/stock-report.pdf", .pdf), ("docs/warehouse-layout.excalidraw", .scene),
        ("docs/reorder.cbase", .base), ("docs/stock-levels.csv", .csv), ("x.tsv", .csv),
        ("README.md", .prose), ("notes.mdx", .prose), ("todo.txt", .prose),
        ("src/stock.ts", .code), ("Makefile", .code), (".gitignore", .code),
        ("clip.MOV", .video), ("demo.webm", .video), ("voice.m4a", .audio), ("song.flac", .audio),
        ("docs/stock-report.html", .html), ("site/INDEX.HTM", .html),
    ])
    func classifiesByExtension(path: String, kind: FileViewerKind) {
        #expect(FileViewerKind(path: path) == kind)
    }

    @Test func textKindsAreEditableAsText() {
        #expect(FileViewerKind.code.isText)
        #expect(FileViewerKind.prose.isText)
        #expect(FileViewerKind.csv.isText)
        #expect(FileViewerKind.base.isText)
        #expect(FileViewerKind.scene.isText)
        #expect(FileViewerKind.html.isText)
        #expect(!FileViewerKind.image.isText)
        #expect(!FileViewerKind.pdf.isText)
        #expect(!FileViewerKind.video.isText)
        #expect(!FileViewerKind.audio.isText)
    }

    @Test func fileSizesReadLikeTheDesktop() {
        #expect(FileSize.label(0) == "0 B")
        #expect(FileSize.label(900) == "900 B")
        #expect(FileSize.label(2048) == "2.0 KiB")
        #expect(FileSize.label(5 * 1024 * 1024 + 300_000) == "5.3 MiB")
    }

    @Test func fileNameHelpers() {
        #expect(FilePath.name("docs/skus/A1.md") == "A1.md")
        #expect(FilePath.stem("docs/skus/A1.md") == "A1")
        #expect(FilePath.ext("docs/x.Tar.GZ") == "gz")
        #expect(FilePath.ext("Makefile") == "")
        #expect(FilePath.directory("docs/skus/A1.md") == "docs/skus")
        #expect(FilePath.directory("README.md") == "")
        #expect(FilePath.renamed("docs/skus/A1.md", stem: "B9") == "docs/skus/B9.md")
        #expect(FilePath.renamed("README.md", stem: "Intro") == "Intro.md")
    }
}
