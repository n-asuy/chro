import Foundation

/// One changed file as the server reports it (log-types `Diff`): whole old
/// and new contents; the phone computes the line diff (`LineDiff`).
public struct FileChange: Equatable, Sendable, Identifiable {
    public enum Kind: String, Equatable, Sendable {
        case added, deleted, modified, renamed, copied
        case permissionChange = "permission_change"
    }

    public var kind: Kind
    public var oldPath: String?
    public var newPath: String?
    public var oldContent: String?
    public var newContent: String?
    /// The server left the contents out (too large); stats may still be set.
    public var contentOmitted: Bool
    public var additions: Int?
    public var deletions: Int?
    public var isBinary: Bool

    public init(kind: Kind, oldPath: String?, newPath: String?, oldContent: String?, newContent: String?,
                contentOmitted: Bool = false, additions: Int? = nil, deletions: Int? = nil, isBinary: Bool = false) {
        self.kind = kind
        self.oldPath = oldPath
        self.newPath = newPath
        self.oldContent = oldContent
        self.newContent = newContent
        self.contentOmitted = contentOmitted
        self.additions = additions
        self.deletions = deletions
        self.isBinary = isBinary
    }

    /// The path rows and keys use (`Diff::path_key`).
    public var path: String { newPath ?? oldPath ?? "" }
    public var id: String { path }
}
