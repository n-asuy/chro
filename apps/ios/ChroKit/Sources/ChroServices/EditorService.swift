import ChroAPI
import ChroDomain
import Foundation

/// A text file as `GET …/file` returns it (`ProjectFileResponse`).
public struct TextFile: Equatable, Sendable {
    public var path: String
    public var content: String
    /// The file's size on disk in bytes.
    public var size: Int
    /// The server returned only a preview of a file over 2 MiB; it must never be written back.
    public var truncated: Bool
    public var modifiedAt: Date?

    public init(path: String, content: String, size: Int, truncated: Bool = false, modifiedAt: Date? = nil) {
        self.path = path
        self.content = content
        self.size = size
        self.truncated = truncated
        self.modifiedAt = modifiedAt
    }
}

/// The bytes of a media file (`GET …/binary-file`).
public struct BinaryFile: Equatable, Sendable {
    public var data: Data
    public var contentType: String

    public init(data: Data, contentType: String) {
        self.data = data
        self.contentType = contentType
    }
}

/// A file as the asset endpoint serves it to the HTML preview: any HTTP status,
/// its `Content-Type` and the body bytes (text replies re-encoded as UTF-8, which
/// is what the server sent: it answers as text only when the body is UTF-8).
public struct AssetResponse: Equatable, Sendable {
    public var status: Int
    public var contentType: String
    public var data: Data

    public init(status: Int, contentType: String, data: Data) {
        self.status = status
        self.contentType = contentType
        self.data = data
    }
}

/// What `cbase/persist` answers: the file's new text and the refreshed view.
public struct CbasePersisted: Equatable, Sendable {
    public var content: String
    public var document: CbaseDocument

    public init(content: String, document: CbaseDocument) {
        self.content = content
        self.document = document
    }
}

/// An expected failure of a file operation, carrying the server's text,
/// which the screen shows as the desktop does (`workspaceError`).
public enum EditorError: Error, Equatable, Sendable {
    /// 404: the file is gone (the server says "path does not exist").
    case notFound(String)
    /// Any other refusal the server explained.
    case refused(String)

    public var message: String {
        switch self {
        case .notFound(let text), .refused(let text): return text
        }
    }

    /// The server's text for a missing file (filesystem `FilesystemError::NotFound`).
    public static let missingText = "path does not exist"
}

/// Opened files: reading and saving text, media bytes, resolving note links,
/// and the `.cbase` view. Every call maps to an allowlisted endpoint
/// (crates/server/src/mobile/allowlist.rs, families Files and Editor):
///
/// | method | endpoint |
/// |---|---|
/// | `read` | `GET …/file?relative_path=` |
/// | `write` | `PUT …/file` `{relative_path, content}` |
/// | `readBinary` | `GET …/binary-file?relative_path=` |
/// | `resolve` | `GET …/resolve-file?name=` |
/// | `readAsset` | `GET …/asset/*relative_path` with the document's query (the HTML preview) |
/// | `queryBase` | `POST /rpc/projects/:project_id/cbase/query` `{content, basePath, viewId}` |
/// | `persistBase` | `POST /rpc/projects/:project_id/cbase/persist` `{basePath, definition, properties, viewId}` |
/// | `setBaseProperty` | `POST /rpc/projects/:project_id/cbase/set-property` `{filePath, key, value}` |
///
/// `…` is `/rpc/projects/:project_id` or `/rpc/task-runs/:id` per `CheckoutScope`
/// (a session's latest run). The `.cbase` engine runs over the project's checkout.
public protocol EditorService: Sendable {
    func read(_ path: String, in scope: CheckoutScope) async throws -> TextFile
    func write(_ path: String, content: String, in scope: CheckoutScope) async throws -> TextFile
    func readBinary(_ path: String, in scope: CheckoutScope) async throws -> BinaryFile
    /// A file of the checkout as the HTML preview's frame loads it, with the query it
    /// asked with (`preview_bridge=1` on the framed document appends the link bridge).
    /// An HTTP error is an answer, not a thrown error; only link failures throw.
    func readAsset(_ path: String, query: [String: String], in scope: CheckoutScope) async throws -> AssetResponse
    /// The root-relative path a note link (`[[name]]`, a bare name or a path suffix) resolves to; nil when none.
    func resolve(_ reference: String, in scope: CheckoutScope) async throws -> String?
    func queryBase(projectID: String, path: String, content: String, viewID: String?) async throws -> CbaseDocument
    func persistBase(projectID: String, path: String, definition: CbaseDefinition, properties: [String: CbaseProperty],
                     viewID: String?) async throws -> CbasePersisted
    /// Rewrites one frontmatter key of a row's note; `.null` removes it.
    func setBaseProperty(projectID: String, filePath: String, key: String, value: JSONValue) async throws
}

extension EditorService {
    /// Files over this size come back as a preview (filesystem workspace.rs `MAX_INLINE_TEXT_FILE_BYTES`).
    public static var inlineTextLimit: Int { 2 * 1024 * 1024 }
    /// How much of an oversized file the preview holds (`LARGE_TEXT_FILE_PREVIEW_BYTES`).
    public static var previewBytes: Int { 512 * 1024 }
}
