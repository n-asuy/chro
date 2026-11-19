import ChroAPI
import ChroDomain
import ChroLink
import Foundation

/// EditorService over the paired desktop: the same `/rpc` routes the desktop's
/// files editor and `.cbase` viewer call (files-api.ts, cbase-client.ts).
/// Failures the server explains come back as `EditorError` with its text.
public final class EditorLiveService: EditorService, @unchecked Sendable {
    private let calls: PanelLiveCalls

    public init(workspace: LiveWorkspace) { calls = PanelLiveCalls(workspace: workspace) }

    public func read(_ path: String, in scope: CheckoutScope) async throws -> TextFile {
        let data = try await json(.get, try await calls.base(scope) + ["file"], query: ["relative_path": path])
        return try decodeFile(data)
    }

    public func write(_ path: String, content: String, in scope: CheckoutScope) async throws -> TextFile {
        let data = try await json(.put, try await calls.base(scope) + ["file"], body: ["relative_path": path, "content": content])
        return try decodeFile(data)
    }

    public func readBinary(_ path: String, in scope: CheckoutScope) async throws -> BinaryFile {
        let response = try await answer(.get, try await calls.base(scope) + ["binary-file"], query: ["relative_path": path])
        switch response {
        case .binary(_, let type, let data): return BinaryFile(data: data, contentType: type)
        case .text(_, let type, let text): return BinaryFile(data: Data(text.utf8), contentType: type)
        case .json(_, let data): return BinaryFile(data: data, contentType: "application/json")
        }
    }

    public func readAsset(_ path: String, query: [String: String], in scope: CheckoutScope) async throws -> AssetResponse {
        let segments = try await calls.base(scope) + ["asset"] + path.split(separator: "/").map(String.init)
        let response = try await calls.workspace.send(RawRequest(path: RawRequest.path(segments), query: query))
        switch response {
        case .binary(let status, let type, let data): return AssetResponse(status: status, contentType: type, data: data)
        case .text(let status, let type, let text): return AssetResponse(status: status, contentType: type, data: Data(text.utf8))
        case .json(let status, let data): return AssetResponse(status: status, contentType: "application/json", data: data)
        }
    }

    public func resolve(_ reference: String, in scope: CheckoutScope) async throws -> String? {
        let data = try await json(.get, try await calls.base(scope) + ["resolve-file"], query: ["name": reference])
        return try calls.decode(Resolved.self, data).relative_path
    }

    public func queryBase(projectID: String, path: String, content: String, viewID: String?) async throws -> CbaseDocument {
        var body: [String: Any] = ["content": content, "basePath": path]
        if let viewID { body["viewId"] = viewID }
        let data = try await json(.post, ["rpc", "projects", projectID, "cbase", "query"], body: body)
        return try calls.decode(CbaseDocument.self, data)
    }

    public func persistBase(projectID: String, path: String, definition: CbaseDefinition, properties: [String: CbaseProperty],
                            viewID: String?) async throws -> CbasePersisted {
        let encoder = JSONEncoder()
        var body: [String: Any] = [
            "basePath": path,
            "definition": try JSONSerialization.jsonObject(with: try encoder.encode(definition)),
            "properties": try JSONSerialization.jsonObject(with: try encoder.encode(properties)),
        ]
        if let viewID { body["viewId"] = viewID }
        let data = try await json(.post, ["rpc", "projects", projectID, "cbase", "persist"], body: body)
        return try calls.decode(PersistAnswer.self, data).persisted
    }

    public func setBaseProperty(projectID: String, filePath: String, key: String, value: JSONValue) async throws {
        let encoded = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(value), options: .fragmentsAllowed)
        _ = try await answer(.post, ["rpc", "projects", projectID, "cbase", "set-property"],
                             body: ["filePath": filePath, "key": key, "value": encoded])
    }

    // MARK: Wire

    private struct FileEnvelope: Decodable {
        struct File: Decodable {
            let relative_path: String
            let content: String
            let size: Int
            let truncated: Bool
            let modified_at: String?
        }

        let file: File
    }

    private struct Resolved: Decodable {
        let relative_path: String?
    }

    private struct PersistAnswer: Decodable {
        let content: String
        let document: CbaseDocument
        var persisted: CbasePersisted { CbasePersisted(content: content, document: document) }
    }

    private func decodeFile(_ data: Data) throws -> TextFile {
        let file = try calls.decode(FileEnvelope.self, data).file
        return TextFile(path: file.relative_path, content: file.content, size: file.size, truncated: file.truncated,
                        modifiedAt: file.modified_at.flatMap(RFC3339.parse))
    }

    private func json(_ method: RawRequest.Method, _ segments: [String], query: [String: String] = [:], body: Any? = nil) async throws -> Data {
        switch try await answer(method, segments, query: query, body: body) {
        case .json(_, let data): return data
        case .text(_, _, let text): return Data(text.utf8)
        case .binary(_, _, let data): return data
        }
    }

    /// One call; a 404 is `EditorError.notFound`, any other error status `EditorError.refused`, both with the server's text.
    private func answer(_ method: RawRequest.Method, _ segments: [String], query: [String: String] = [:], body: Any? = nil) async throws -> RawResponse {
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
        let response = try await calls.workspace.send(RawRequest(method: method, path: RawRequest.path(segments), query: query, body: data))
        guard (200..<300).contains(response.status) else {
            let text = PanelLiveCalls.errorText(response)
            throw response.status == 404 ? EditorError.notFound(text) : EditorError.refused(text)
        }
        return response
    }

}
