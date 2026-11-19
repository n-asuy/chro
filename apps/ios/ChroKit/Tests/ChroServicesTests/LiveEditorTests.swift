import ChroAPI
import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// EditorService over the link: the files editor's and the `.cbase` viewer's
/// routes and bodies, run scopes through the session's newest run, and the
/// server's error text.
@Suite(.timeLimit(.minutes(1)))
struct LiveEditorTests {
    static let project = "11111111-0000-4000-8000-000000000001"
    static let task = "aaaa0000-0000-4000-8000-000000000001"
    let desktop = FakeDesktop()

    static func file(_ path: String, _ content: String, truncated: Bool = false, size: Int? = nil) -> FakeResponder.HTTPReply {
        .json(status: 200, FakeDesktop.text(["file": ["relative_path": path, "content": content, "size": size ?? content.utf8.count,
                                                      "truncated": truncated, "modified_at": "2026-11-14T09:00:00Z"]]))
    }

    init() {
        desktop.edit { d in
            d.projects = [FakeDesktop.project(Self.project, name: "inventory-service", path: "/Users/me/inventory-service")]
            d.tasks = [Self.task: FakeDesktop.task(Self.task, project: Self.project, title: "Add removeStock")]
            d.replies["GET /rpc/tasks/\(Self.task)/runs"] = .json(status: 200, FakeDesktop.text(["runs": [
                ["id": "run-1", "status": "completed", "created_at": "2026-11-14T08:00:00Z"],
                ["id": "run-2", "status": "completed", "created_at": "2026-11-14T08:30:00Z"],
            ]]))
        }
    }

    /// A phone whose link is up (the session feed subscribed), so calls do not race the first connection.
    private func connectedEditor() async throws -> (EditorLiveService, FakeDesktop.Phone) {
        let phone = try desktop.phone()
        try await eventually("connected") { desktop.responders.first?.subscriptions.isEmpty == false }
        return (EditorLiveService(workspace: phone.workspace), phone)
    }

    @Test func readsAndWritesTheProjectsFile() async throws {
        desktop.edit { d in
            d.replies["GET /rpc/projects/\(Self.project)/file"] = Self.file("README.md", "# inventory-service\n")
            d.replies["PUT /rpc/projects/\(Self.project)/file"] = Self.file("README.md", "# changed\n")
        }
        let (editor, phone) = try await connectedEditor()
        defer { withExtendedLifetime(phone) {} }
        let file = try await editor.read("README.md", in: .project(id: Self.project))
        #expect(file.content == "# inventory-service\n")
        #expect(file.modifiedAt != nil)
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.project)/file").first?.query == ["relative_path": "README.md"])
        let saved = try await editor.write("README.md", content: "# changed\n", in: .project(id: Self.project))
        #expect(saved.content == "# changed\n")
        let put = try #require(desktop.requests("PUT", "/rpc/projects/\(Self.project)/file").first?.bodyObject as? [String: Any])
        #expect(put["relative_path"] as? String == "README.md")
        #expect(put["content"] as? String == "# changed\n")
    }

    @Test func aSessionReadsItsNewestRunsWorktree() async throws {
        desktop.edit { d in d.replies["GET /rpc/task-runs/run-2/file"] = Self.file("src/stock.ts", "export {}\n", truncated: true, size: 3_000_000) }
        let (editor, phone) = try await connectedEditor()
        defer { withExtendedLifetime(phone) {} }
        let file = try await editor.read("src/stock.ts", in: .run(sessionID: Self.task))
        #expect(file.truncated)
        #expect(file.size == 3_000_000)
    }

    @Test func missingFilesCarryTheServersText() async throws {
        desktop.edit { d in d.failures["/rpc/projects/\(Self.project)/file"] = (404, "path does not exist") }
        let (editor, phone) = try await connectedEditor()
        defer { withExtendedLifetime(phone) {} }
        await #expect(throws: EditorError.notFound("path does not exist")) { try await editor.read("gone.md", in: .project(id: Self.project)) }
        desktop.edit { d in d.failures["/rpc/projects/\(Self.project)/file"] = (400, "path is outside the workspace root") }
        await #expect(throws: EditorError.refused("path is outside the workspace root")) {
            try await editor.write("../x", content: "", in: .project(id: Self.project))
        }
    }

    @Test func mediaBytesComeInBinaryFrames() async throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 1, 2, 3])
        desktop.edit { d in d.replies["GET /rpc/projects/\(Self.project)/binary-file"] = .binary(status: 200, contentType: "image/png", png) }
        let (editor, phone) = try await connectedEditor()
        defer { withExtendedLifetime(phone) {} }
        let media = try await editor.readBinary("docs/a.png", in: .project(id: Self.project))
        #expect(media == BinaryFile(data: png, contentType: "image/png"))
    }

    /// The HTML preview reads the asset endpoint the desktop's frame loads, whatever
    /// shape the reply takes: HTML and CSS come back as text, images in binary frames,
    /// and an error status is an answer for the web view rather than a thrown error.
    @Test func previewAssetsComeFromTheAssetRoute() async throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 1, 2, 3])
        let html = "<html><body>在庫</body></html>\n<script>bridge</script>"
        desktop.edit { d in
            d.replies["GET /rpc/projects/\(Self.project)/asset/docs/stock%20report.html"] = .text(status: 200, contentType: "text/html", html)
            d.replies["GET /rpc/task-runs/run-2/asset/docs/images/a.png"] = .binary(status: 200, contentType: "image/png", png)
            d.failures["/rpc/projects/\(Self.project)/asset/docs/gone.css"] = (404, "path does not exist")
        }
        let (editor, phone) = try await connectedEditor()
        defer { withExtendedLifetime(phone) {} }

        let page = try await editor.readAsset("docs/stock report.html", query: ["preview_bridge": "1", "_r": "0"], in: .project(id: Self.project))
        #expect(page == AssetResponse(status: 200, contentType: "text/html", data: Data(html.utf8)))
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.project)/asset/docs/stock%20report.html").first?.query == ["preview_bridge": "1", "_r": "0"])

        let image = try await editor.readAsset("docs/images/a.png", query: [:], in: .run(sessionID: Self.task))
        #expect(image == AssetResponse(status: 200, contentType: "image/png", data: png))

        let missing = try await editor.readAsset("docs/gone.css", query: [:], in: .project(id: Self.project))
        #expect(missing.status == 404)
        #expect(String(decoding: missing.data, as: UTF8.self) == "path does not exist")
        #expect(desktop.violations.isEmpty)
    }

    @Test func noteLinksResolveThroughTheServersIndex() async throws {
        desktop.edit { d in
            d.replies["GET /rpc/projects/\(Self.project)/resolve-file"] = .json(status: 200, FakeDesktop.text(["root": "/Users/me/inventory-service", "relative_path": "README.md"]))
        }
        let (editor, phone) = try await connectedEditor()
        defer { withExtendedLifetime(phone) {} }
        #expect(try await editor.resolve("README", in: .project(id: Self.project)) == "README.md")
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.project)/resolve-file").first?.query == ["name": "README"])
        desktop.edit { d in d.replies["GET /rpc/projects/\(Self.project)/resolve-file"] = .json(status: 200, FakeDesktop.text(["root": NSNull(), "relative_path": NSNull()])) }
        #expect(try await editor.resolve("ghost", in: .project(id: Self.project)) == nil)
    }

    static var document: [String: Any] { [
        "definition": ["version": 1, "name": "reorder", "dataset": ["include": ["docs/skus/*.md"]],
                       "properties": ["on_hand": ["key": "on_hand", "type": "number"]],
                       "views": [["id": "all", "name": "All SKUs", "type": "table", "table": ["columns": ["on_hand"], "column_widths": ["on_hand": 120]]]]],
        "properties": ["on_hand": ["key": "on_hand", "type": "number"]],
        "views": [["view": ["id": "all", "name": "All SKUs", "type": "table"],
                   "rows": [["filePath": "docs/skus/A1.md", "displayName": "A1", "values": ["on_hand": 5]]],
                   "totalCount": 1, "pageOffset": 0, "hasMore": false]],
        "isQueryLanguage": false,
    ] }

    @Test func baseCallsUseTheViewersBodies() async throws {
        desktop.edit { d in
            d.replies["POST /rpc/projects/\(Self.project)/cbase/query"] = .json(status: 200, FakeDesktop.text(Self.document))
            d.replies["POST /rpc/projects/\(Self.project)/cbase/persist"] = .json(status: 200, FakeDesktop.text(["content": "version: 1\n", "document": Self.document]))
            d.replies["POST /rpc/projects/\(Self.project)/cbase/set-property"] = .empty(status: 204)
        }
        let (editor, phone) = try await connectedEditor()
        defer { withExtendedLifetime(phone) {} }
        let document = try await editor.queryBase(projectID: Self.project, path: "docs/reorder.cbase", content: "{}", viewID: "all")
        #expect(document.views.first?.rows.first?.values["on_hand"] == .number(5))
        #expect(document.definition?.views.first?.table?.column_widths == ["on_hand": 120])
        let query = try #require(desktop.requests("POST", "/rpc/projects/\(Self.project)/cbase/query").first?.bodyObject as? [String: Any])
        #expect(query["basePath"] as? String == "docs/reorder.cbase")
        #expect(query["viewId"] as? String == "all")
        #expect(query["content"] as? String == "{}")

        let persisted = try await editor.persistBase(projectID: Self.project, path: "docs/reorder.cbase", definition: try #require(document.definition),
                                                     properties: document.properties, viewID: "all")
        #expect(persisted.content == "version: 1\n")
        let persist = try #require(desktop.requests("POST", "/rpc/projects/\(Self.project)/cbase/persist").first?.bodyObject as? [String: Any])
        #expect(persist["basePath"] as? String == "docs/reorder.cbase")
        #expect((persist["definition"] as? [String: Any])?["name"] as? String == "reorder")
        #expect(persist["properties"] is [String: Any])

        try await editor.setBaseProperty(projectID: Self.project, filePath: "docs/skus/A1.md", key: "reviewed", value: .bool(true))
        let set = try #require(desktop.requests("POST", "/rpc/projects/\(Self.project)/cbase/set-property").first?.bodyObject as? [String: Any])
        #expect(set["filePath"] as? String == "docs/skus/A1.md")
        #expect(set["key"] as? String == "reviewed")
        #expect(set["value"] as? Bool == true)
        #expect(desktop.violations.isEmpty)
    }
}
