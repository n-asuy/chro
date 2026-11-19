import ChroDomain
import Foundation

/// One line of a content-search hit (`ProjectLineMatch`); ranges are UTF-16 offsets into `text`.
public struct FileLineMatch: Equatable, Sendable, Identifiable {
    public var lineNumber: Int
    public var text: String
    public var ranges: [Range<Int>]
    public var id: Int { lineNumber }

    public init(lineNumber: Int, text: String, ranges: [Range<Int>]) {
        self.lineNumber = lineNumber
        self.text = text
        self.ranges = ranges
    }
}

/// One file of a search result (`ProjectSearchResult`). Name-only matches have no lines.
public struct FileSearchHit: Equatable, Sendable, Identifiable {
    public var path: String
    public var isFile: Bool
    public var lines: [FileLineMatch]
    public var modifiedAt: Date?
    public var id: String { path }

    public init(path: String, isFile: Bool = true, lines: [FileLineMatch] = [], modifiedAt: Date? = nil) {
        self.path = path
        self.isFile = isFile
        self.lines = lines
        self.modifiedAt = modifiedAt
    }
}

/// GET /rpc/projects/:project_id/search?kind=content.
public struct FileSearchResults: Equatable, Sendable {
    public var hits: [FileSearchHit]
    /// Files matched before the server's cap (at least `hits.count`).
    public var totalFiles: Int
    public var totalLineMatches: Int
    /// The cap was hit, so the totals are lower bounds.
    public var truncated: Bool

    public init(hits: [FileSearchHit], totalFiles: Int, totalLineMatches: Int, truncated: Bool) {
        self.hits = hits
        self.totalFiles = totalFiles
        self.totalLineMatches = totalLineMatches
        self.truncated = truncated
    }

    public static let empty = FileSearchResults(hits: [], totalFiles: 0, totalLineMatches: 0, truncated: false)
}

/// GET /rpc/projects/:project_id/directory-agent.
public struct DirectoryAgentInfo: Equatable, Sendable {
    public struct Entry: Equatable, Sendable, Identifiable {
        public var sessionID: String
        public var title: String
        public var summary: String?
        public var outcome: LedgerOutcome
        public var updatedAt: Date
        public var id: String { sessionID }

        public init(sessionID: String, title: String, summary: String?, outcome: LedgerOutcome, updatedAt: Date) {
            self.sessionID = sessionID
            self.title = title
            self.summary = summary
            self.outcome = outcome
            self.updatedAt = updatedAt
        }
    }

    /// Root-relative directory (`""` is the root).
    public var path: String
    /// The brief file inside the directory.
    public var brief: String?
    /// The nearest ancestor's brief, governing when `brief` is nil.
    public var inheritedBrief: String?
    /// Finished sessions addressed to the directory, most recent first.
    public var ledger: [Entry]

    public init(path: String, brief: String?, inheritedBrief: String?, ledger: [Entry]) {
        self.path = path
        self.brief = brief
        self.inheritedBrief = inheritedBrief
        self.ledger = ledger
    }
}

/// Files and Search in the right dock, and the Agent panel (directory agent).
///
/// Reads: `/rpc/projects/:project_id/entries`, `/rpc/task-runs/:id/entries`,
/// `/rpc/projects/:project_id/search`, `/rpc/projects/:project_id/directory-agent`,
/// the run's diff stream (`/rpc/task-runs/:id/diff`, stats only) and the repo
/// events streams. Writes (project scope only, as on the desktop): `PUT
/// /rpc/projects/:project_id/file`, `POST …/directory`, `POST …/rename`,
/// `POST …/copy`, `DELETE …/file`.
public protocol FilesService: Sendable {
    /// Absolute path of the checkout root on the desktop (Copy Full Path).
    func checkoutRoot(_ scope: CheckoutScope) async throws -> String
    /// Every entry of the checkout, recursively, as the server lists them
    /// (hidden folders left out unless the shared setting shows them).
    func entries(_ scope: CheckoutScope) async throws -> [FileTreeEntry]
    /// Root-relative paths a run changed against its base.
    func changedPaths(sessionID: String) async throws -> [String]
    /// Fires once on subscription, then whenever files of the checkout change on disk.
    func changes(_ scope: CheckoutScope) -> AsyncStream<Void>

    /// Full-text search with the content grammar (`FileSearchQuery`).
    func searchContent(projectID: String, query: String, matchCase: Bool, sort: FileSearchSort, limit: Int) async throws -> FileSearchResults
    /// Name/path search (kind=name), for `path:`/`file:` completion.
    func searchNames(projectID: String, query: String, limit: Int) async throws -> [FileSearchHit]

    func createFile(projectID: String, path: String, content: String) async throws
    func createDirectory(projectID: String, path: String) async throws
    /// Rename or move.
    func rename(projectID: String, from: String, to: String) async throws
    func copy(projectID: String, from: String, to: String) async throws
    func delete(projectID: String, path: String) async throws

    func directoryAgent(projectID: String, path: String) async throws -> DirectoryAgentInfo

    /// Which path-like references of a conversation name something that exists
    /// (`POST /rpc/tasks/:id/probe-paths` for a session, `/rpc/projects/:id/probe-paths`
    /// for a project); answers are index-aligned with `references`.
    func probePaths(_ references: [String], in scope: CheckoutScope) async throws -> [PathProbeResult]
}
