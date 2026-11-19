import ChroAPI
import ChroDomain
import ChroLink
import Foundation

/// FilesService over the paired desktop, with the desktop's routes and
/// payloads (lib/project-client.ts, lib/directory-map-client.ts).
final class FilesLiveService: FilesService, @unchecked Sendable {
    private let calls: PanelLiveCalls

    init(calls: PanelLiveCalls) { self.calls = calls }

    func checkoutRoot(_ scope: CheckoutScope) async throws -> String {
        switch scope {
        case .project(let id):
            return try await calls.workspace.projectRow(id).gitRepoPath
        case .run(let sessionID):
            guard let path = try await calls.run(sessionID: sessionID).worktreePath else { throw ServiceError.notFound("The worktree") }
            return path
        }
    }

    /// `GET …/entries?recursive=true`: the nested tree, flattened.
    func entries(_ scope: CheckoutScope) async throws -> [FileTreeEntry] {
        let data = try await calls.body(.get, try await calls.base(scope) + ["entries"], query: ["recursive": "true"])
        var flat: [FileTreeEntry] = []
        func collect(_ entries: [Entry]) {
            for entry in entries {
                flat.append(FileTreeEntry(path: entry.relativePath, isDirectory: entry.type == "directory"))
                collect(entry.children ?? [])
            }
        }
        collect(try calls.decode(EntriesEnvelope.self, data).entries)
        return flat.sorted { $0.path < $1.path }
    }

    /// The paths of the run's diff (`stats_only`, first snapshot).
    func changedPaths(sessionID: String) async throws -> [String] {
        let run = try await calls.run(sessionID: sessionID)
        return try await calls.diffSnapshot(runID: run.id, statsOnly: true).map(\.path).sorted()
    }

    /// The files channel of the checkout's repo events.
    func changes(_ scope: CheckoutScope) -> AsyncStream<Void> {
        calls.invalidations(scope, channels: ["files"])
    }

    // MARK: Path links

    /// `POST /rpc/tasks/:id/probe-paths` or `/rpc/projects/:id/probe-paths` (path-link.ts):
    /// a session resolves against its task's roots, keyed by task rather than run.
    func probePaths(_ references: [String], in scope: CheckoutScope) async throws -> [PathProbeResult] {
        guard !references.isEmpty else { return [] }
        let segments: [String]
        switch scope {
        case .run(let sessionID): segments = ["rpc", "tasks", sessionID, "probe-paths"]
        case .project(let id): segments = ["rpc", "projects", id, "probe-paths"]
        }
        let data = try await calls.body(.post, segments, body: ["paths": references])
        return try calls.decode(ProbeEnvelope.self, data).results.map(\.result)
    }

    // MARK: Search

    /// `GET /rpc/projects/:id/search?kind=content` (search-panel.tsx): smart case
    /// unless Match Case sends `case=sensitive`.
    func searchContent(projectID: String, query: String, matchCase: Bool, sort: FileSearchSort, limit: Int) async throws -> FileSearchResults {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .empty }
        var parameters = ["q": query, "kind": "content", "limit": String(limit), "sort": sort.rawValue]
        if matchCase { parameters["case"] = "sensitive" }
        let response = try calls.decode(SearchEnvelope.self, try await calls.body(.get, ["rpc", "projects", projectID, "search"], query: parameters))
        return FileSearchResults(hits: response.results.map(\.hit), totalFiles: response.totalFiles,
                                 totalLineMatches: response.totalLineMatches, truncated: response.truncated)
    }

    /// `kind=name`, as the `path:`/`file:` completion asks; an empty query asks nothing.
    func searchNames(projectID: String, query: String, limit: Int) async throws -> [FileSearchHit] {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        let data = try await calls.body(.get, ["rpc", "projects", projectID, "search"], query: ["q": query, "kind": "name", "limit": String(limit)])
        return try calls.decode(SearchEnvelope.self, data).results.map(\.hit)
    }

    // MARK: Writes

    func createFile(projectID: String, path: String, content: String) async throws {
        try await calls.send(.put, ["rpc", "projects", projectID, "file"], body: ["relative_path": path, "content": content])
    }

    func createDirectory(projectID: String, path: String) async throws {
        try await calls.send(.post, ["rpc", "projects", projectID, "directory"], body: ["relative_path": path])
    }

    func rename(projectID: String, from: String, to: String) async throws {
        try await calls.send(.post, ["rpc", "projects", projectID, "rename"], body: ["old_relative_path": from, "new_relative_path": to])
    }

    func copy(projectID: String, from: String, to: String) async throws {
        try await calls.send(.post, ["rpc", "projects", projectID, "copy"], body: ["source_relative_path": from, "dest_relative_path": to])
    }

    func delete(projectID: String, path: String) async throws {
        try await calls.send(.delete, ["rpc", "projects", projectID, "file"], query: ["relative_path": path])
    }

    func directoryAgent(projectID: String, path: String) async throws -> DirectoryAgentInfo {
        let data = try await calls.body(.get, ["rpc", "projects", projectID, "directory-agent"], query: ["path": path])
        let agent = try calls.decode(DirectoryAgentWire.self, data)
        return DirectoryAgentInfo(
            path: agent.path, brief: agent.brief?.path, inheritedBrief: agent.inheritedBrief?.path,
            ledger: agent.ledger.compactMap { entry in
                guard let outcome = LedgerOutcome(rawValue: entry.outcome) else { return nil }
                return .init(sessionID: entry.taskId, title: entry.title, summary: entry.summary, outcome: outcome,
                             updatedAt: RFC3339.parse(entry.updatedAt) ?? .distantPast)
            }
        )
    }

    // MARK: Wire

    private struct Entry: Decodable {
        let type: String
        let relativePath: String
        let children: [Entry]?
    }

    private struct EntriesEnvelope: Decodable { let entries: [Entry] }

    private struct SearchEnvelope: Decodable {
        struct Result: Decodable {
            struct Line: Decodable {
                let lineNumber: Int
                let lineContent: String
                let ranges: [[Int]]

                enum CodingKeys: String, CodingKey {
                    case lineNumber = "line_number", lineContent = "line_content", ranges
                }
            }

            let path: String
            let isFile: Bool
            let lineMatches: [Line]
            let modifiedAt: String?

            enum CodingKeys: String, CodingKey {
                case path, isFile = "is_file", lineMatches = "line_matches", modifiedAt = "modified_at"
            }

            var hit: FileSearchHit {
                FileSearchHit(
                    path: path, isFile: isFile,
                    lines: lineMatches.map { line in
                        FileLineMatch(lineNumber: line.lineNumber, text: line.lineContent,
                                      ranges: line.ranges.compactMap { $0.count == 2 && $0[0] <= $0[1] ? $0[0]..<$0[1] : nil })
                    },
                    modifiedAt: modifiedAt.flatMap(RFC3339.parse)
                )
            }
        }

        let results: [Result]
        let totalFiles: Int
        let totalLineMatches: Int
        let truncated: Bool

        enum CodingKeys: String, CodingKey {
            case results, totalFiles = "total_files", totalLineMatches = "total_line_matches", truncated
        }
    }

    private struct ProbeEnvelope: Decodable {
        struct Probe: Decodable {
            let exists: Bool
            let kind: String?
            let absolutePath: String?
            let root: String?
            let relativePath: String?
            let line: Int?
            let column: Int?

            enum CodingKeys: String, CodingKey {
                case exists, kind, root, line, column, absolutePath = "absolute_path", relativePath = "relative_path"
            }

            var result: PathProbeResult {
                PathProbeResult(exists: exists, kind: kind.flatMap(PathProbeResult.Kind.init(rawValue:)), absolutePath: absolutePath,
                                root: root, relativePath: relativePath, line: line, column: column)
            }
        }

        let results: [Probe]
    }

    private struct DirectoryAgentWire: Decodable {
        struct Brief: Decodable { let path: String }
        struct LedgerEntry: Decodable {
            let taskId: String
            let title: String
            let summary: String?
            let outcome: String
            let updatedAt: String
        }

        let path: String
        let brief: Brief?
        let inheritedBrief: Brief?
        let ledger: [LedgerEntry]
    }
}
