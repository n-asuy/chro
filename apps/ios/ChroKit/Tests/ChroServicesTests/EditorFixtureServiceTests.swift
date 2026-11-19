import ChroAPI
import ChroDomain
import Foundation
import Testing
@testable import ChroServices

/// EditorService over the mock's checkouts: reads, saves that the other
/// panels see, media bytes, note links and the `.cbase` view.
@Suite struct EditorFixtureServiceTests {
    let checkouts = DockFixtureCheckouts()
    var editor: EditorFixtureService { EditorFixtureService(checkouts: checkouts) }
    let project = CheckoutScope.project(id: "inv")
    let run = CheckoutScope.run(sessionID: "7a3f5d10-add")

    @Test func readsTheCapturedText() async throws {
        let file = try await editor.read("src/stock.ts", in: run)
        #expect(file.content.hasPrefix("export interface Item { sku: string; qty: number }"))
        #expect(file.size == file.content.utf8.count)
        #expect(!file.truncated)
        let readme = try await editor.read("README.md", in: project)
        #expect(readme.content.contains("Tracks on-hand and reserved stock for every SKU."))
    }

    @Test func missingFilesAndFoldersAreNotFound() async {
        await #expect(throws: EditorError.notFound(EditorError.missingText)) { try await editor.read("nope.ts", in: project) }
        await #expect(throws: EditorError.notFound("target is not a file")) { try await editor.read("docs", in: project) }
    }

    @Test func writesLandInTheSharedCheckout() async throws {
        let saved = try await editor.write("README.md", content: "# changed\n", in: project)
        #expect(saved.content == "# changed\n")
        #expect(checkouts.checkout(project)?.nodes["README.md"]?.text == "# changed\n")
        _ = try await editor.write("docs/new/note.md", content: "x", in: project)
        #expect(checkouts.checkout(project)?.nodes["docs/new"] == .directory)
    }

    @Test func oversizedTextComesBackAsAPreview() async throws {
        let big = String(repeating: "a", count: EditorFixtureService.inlineTextLimit + 10)
        _ = try await editor.write("big.txt", content: big, in: project)
        let file = try await editor.read("big.txt", in: project)
        #expect(file.truncated)
        #expect(file.content.utf8.count == EditorFixtureService.previewBytes)
        #expect(file.size == big.utf8.count)
    }

    @Test func mediaBytesAndTypes() async throws {
        let image = try await editor.readBinary("docs/images/sku-heatmap.png", in: .run(sessionID: "bd50a1e2-img"))
        #expect(image.contentType == "image/png")
        #expect(image.data.starts(with: [0x89, 0x50, 0x4E, 0x47]))
        let pdf = try await editor.readBinary("docs/stock-report.pdf", in: project)
        #expect(pdf.contentType == "application/pdf")
        #expect(pdf.data.starts(with: Array("%PDF".utf8)))
    }

    /// The asset endpoint as the server answers it: the files the hand-made report
    /// loads, the bridge appended to the opted-in document only, and 404 for a missing file.
    @Test func previewAssetsAnswerLikeTheServer() async throws {
        let editor = EditorFixtureService(checkouts: checkouts, previewBridge: "\n<script>bridge</script>\n")
        let page = try await editor.readAsset("docs/report/index.html", query: ["preview_bridge": "1"], in: project)
        #expect(page.status == 200)
        #expect(page.contentType == "text/html")
        let text = String(decoding: page.data, as: UTF8.self)
        #expect(text.contains("href=\"report.css\""))
        #expect(text.contains("src=\"report.js\""))
        #expect(text.contains("src=\"heatmap.png\""))
        #expect(text.hasSuffix("\n<script>bridge</script>\n"))

        let plain = try await editor.readAsset("docs/report/index.html", query: [:], in: project)
        #expect(!String(decoding: plain.data, as: UTF8.self).contains("<script>bridge</script>"))
        let css = try await editor.readAsset("docs/report/report.css", query: ["preview_bridge": "1"], in: project)
        #expect(css.contentType == "text/css")
        #expect(!String(decoding: css.data, as: UTF8.self).contains("bridge"))
        #expect(try await editor.readAsset("docs/report/report.js", query: [:], in: project).contentType == "text/javascript")
        let image = try await editor.readAsset("docs/report/heatmap.png", query: [:], in: project)
        #expect(image.contentType == "image/png")
        #expect(image.data.starts(with: [0x89, 0x50, 0x4E, 0x47]))

        let missing = try await editor.readAsset("docs/report/nope.css", query: [:], in: project)
        #expect(missing.status == 404)
        #expect(try await editor.readAsset("docs", query: [:], in: project).status == 404)
    }

    @Test func noteLinksResolveByNameOrPathSuffix() async throws {
        #expect(try await editor.resolve("README", in: project) == "README.md")
        #expect(try await editor.resolve("skus/B2.md", in: project) == "docs/skus/B2.md")
        #expect(try await editor.resolve("B2", in: project) == "docs/skus/B2.md")
        #expect(try await editor.resolve("ghost", in: project) == nil)
    }

    @Test func baseQueryMaterializesTheNotesOfTheDataset() async throws {
        let content = try await editor.read("docs/reorder.cbase", in: project).content
        let document = try await editor.queryBase(projectID: "inv", path: "docs/reorder.cbase", content: content, viewID: "low-stock")
        #expect(document.parseError == nil)
        #expect(document.views.map(\.view.name) == ["All SKUs", "Low stock"])
        let all = document.views[0]
        #expect(all.rows.map(\.displayName) == ["A1", "B2", "C3"])
        #expect(all.rows[0].values["on_hand"] == .number(5))
        #expect(all.rows[0].values["reviewed"] == .bool(true))
        #expect(document.views[1].rows.map(\.displayName) == ["B2"])
        #expect(document.views[1].totalCount == 1)
    }

    @Test func baseQueryReportsDefinitionsItCannotRead() async throws {
        let document = try await editor.queryBase(projectID: "inv", path: "x.cbase", content: "views: [", viewID: nil)
        #expect(document.parseError != nil)
        #expect(document.views.isEmpty)
    }

    @Test func persistWritesTheDefinitionAndRequeries() async throws {
        let content = try await editor.read("docs/reorder.cbase", in: project).content
        var document = try await editor.queryBase(projectID: "inv", path: "docs/reorder.cbase", content: content, viewID: nil)
        var definition = try #require(document.definition)
        definition.views[0].sort = [CbaseSort(by: "on_hand", dir: .desc)]
        let persisted = try await editor.persistBase(projectID: "inv", path: "docs/reorder.cbase", definition: definition,
                                                     properties: document.properties, viewID: "all-skus")
        #expect(persisted.document.views[0].rows.map(\.displayName) == ["C3", "A1", "B2"])
        #expect(checkouts.checkout(project)?.nodes["docs/reorder.cbase"]?.text == persisted.content)
        document = try await editor.queryBase(projectID: "inv", path: "docs/reorder.cbase", content: persisted.content, viewID: nil)
        #expect(document.definition?.views[0].sort == [CbaseSort(by: "on_hand", dir: .desc)])
    }

    @Test func setPropertyRewritesTheRowNote() async throws {
        try await editor.setBaseProperty(projectID: "inv", filePath: "docs/skus/B2.md", key: "reviewed", value: .bool(true))
        let note = try #require(checkouts.checkout(project)?.nodes["docs/skus/B2.md"]?.text)
        #expect(note.contains("reviewed: true"))
        try await editor.setBaseProperty(projectID: "inv", filePath: "docs/skus/B2.md", key: "on_hand", value: .number(7))
        #expect(checkouts.checkout(project)?.nodes["docs/skus/B2.md"]?.text?.contains("on_hand: 7") == true)
        try await editor.setBaseProperty(projectID: "inv", filePath: "docs/skus/B2.md", key: "status", value: .null)
        #expect(checkouts.checkout(project)?.nodes["docs/skus/B2.md"]?.text?.contains("status:") == false)
    }
}
