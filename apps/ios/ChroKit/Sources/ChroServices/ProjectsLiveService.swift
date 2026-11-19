import ChroAPI
import ChroDomain
import ChroLink
import Foundation

/// The desktop's sidebar projects: the open tabs (`chro.openProjectTabs`) and
/// the recent workspaces (`chro.recentWorkspaces`) live in the UI state, the
/// project records (badge colour, General flag) in `GET /rpc/projects`.
extension LiveWorkspace {
    enum ProjectKey {
        /// `[{id, slug, name, workspacePath}]` (open-projects-store.ts).
        static let openTabs = "chro.openProjectTabs"
        /// `[{path, lastOpenedAt (ms), projectId?, projectSlug?, projectName?}]`, newest first (workspace-history.ts).
        static let recentWorkspaces = "chro.recentWorkspaces"
        static let maxRecentWorkspaces = 5
    }

    func publishProjects() {
        let (tabs, recents, rows, revision) = locked {
            (uiState[ProjectKey.openTabs], uiState[ProjectKey.recentWorkspaces], projectRows, nextSnapshotRevision())
        }
        let byID = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var open: [ProjectSummary] = []
        if case .array(let entries)? = tabs {
            for case .object(let tab) in entries {
                guard case .string(let id)? = tab["id"], case .string(let name)? = tab["name"] else { continue }
                if let row = byID[id] {
                    open.append(row.summary)
                } else {
                    var path = ""
                    if case .string(let stored)? = tab["workspacePath"] { path = stored }
                    open.append(ProjectSummary(id: id, name: name, path: path))
                }
            }
        }
        var recent: [ProjectSummary] = []
        if case .array(let entries)? = recents {
            for case .object(let entry) in entries.prefix(ProjectKey.maxRecentWorkspaces) {
                guard case .string(let path)? = entry["path"] else { continue }
                var projectID: String?
                if case .string(let id)? = entry["projectId"] { projectID = id }
                let row = projectID.flatMap { byID[$0] } ?? rows.first { Self.samePath($0.gitRepoPath, path) }
                if let row {
                    recent.append(row.summary)
                } else if let projectID {
                    var name = String(path.split(separator: "/").last ?? Substring(path))
                    if case .string(let stored)? = entry["projectName"] { name = stored }
                    recent.append(ProjectSummary(id: projectID, name: name, path: path))
                }
            }
        }
        let scratch = Set(rows.filter(\.isGeneral).map(\.id))
        projectState.publish(ProjectsState(openProjects: open, recents: recent, scratchProjectIDs: scratch), revision: revision)
    }

    /// normalizePathForCompare of workspace-history.ts.
    static func normalizedPath(_ path: String) -> String {
        var normalized = path.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\\", with: "/")
        while normalized.contains("//") { normalized = normalized.replacingOccurrences(of: "//", with: "/") }
        if normalized.count == 3, normalized.hasSuffix(":/") { return normalized }
        if normalized.hasSuffix("/") { normalized.removeLast() }
        return normalized
    }

    static func samePath(_ a: String, _ b: String) -> Bool { normalizedPath(a) == normalizedPath(b) }

    private struct EnsureProject: Encodable {
        let gitRepoPath: String
    }

    private struct BadgeColor: Encodable {
        let badgeColor: String?
        enum CodingKeys: String, CodingKey { case badgeColor = "badge_color" }
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(badgeColor, forKey: .badgeColor)  // null clears the colour
        }
    }

    /// `GET /rpc/filesystem/directory` (filesystem crate `DirectoryListResponse`).
    private struct DirectoryResponse: Decodable {
        struct Entry: Decodable {
            let name: String
            let isDirectory: Bool
            let isGitRepo: Bool
        }

        let entries: [Entry]
        let currentPath: String
        let isGitRepo: Bool
    }

    private func directory(_ path: String?) async throws -> DirectoryResponse {
        do {
            return try await json(DirectoryResponse.self, RawRequest(path: "/rpc/filesystem/directory", query: path.map { ["path": $0] } ?? [:]))
        } catch {
            // filesystem-client.ts surfaces this title for any failure.
            throw ServiceError.unavailable("Failed to load directory")
        }
    }

    func updateProjectRow(_ row: ProjectRow) {
        locked {
            if let index = projectRows.firstIndex(where: { $0.id == row.id }) {
                projectRows[index] = row
            } else {
                projectRows.append(row)
            }
        }
        publishProjects()
    }
}

extension LiveWorkspace: ProjectsService {
    public func projects() -> AsyncStream<ProjectsState> { projectState.stream() }

    public func ensureScratchProject() async throws -> String {
        if let known = projectState.value.scratchProjectIDs.sorted().first { return known }
        let row = try await json(ProjectEnvelope.self, RawRequest(method: .post, path: "/rpc/projects/general", body: Self.body([String: String]()))).row
        updateProjectRow(row)
        return row.id
    }

    /// open-workspace.ts: ensure the project, record it as recent, open it as a tab.
    public func openWorkspace(path: String) async throws -> ProjectSummary {
        let trimmed = path.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { throw ServiceError.invalid("Choose a folder to open.") }
        let envelope = try await json(ProjectEnvelope.self, RawRequest(method: .post, path: "/rpc/projects/ensure", body: Self.body(EnsureProject(gitRepoPath: trimmed))))
        let row = envelope.row
        updateProjectRow(row)

        var recents: [JSONValue] = []
        var tabs: [JSONValue] = []
        locked {
            if case .array(let stored)? = uiState[ProjectKey.recentWorkspaces] { recents = stored }
            if case .array(let stored)? = uiState[ProjectKey.openTabs] { tabs = stored }
        }
        let prior = recents.first { Self.recentPath($0).map { Self.samePath($0, trimmed) } ?? false }
        recents.removeAll { Self.recentPath($0).map { Self.samePath($0, trimmed) } ?? false }
        var entry: [String: JSONValue] = [
            "path": .string(trimmed),
            "lastOpenedAt": .number((now().timeIntervalSince1970 * 1000).rounded()),
            "projectId": .string(row.id),
            "projectName": .string(row.name),
        ]
        entry["projectSlug"] = row.slug.map(JSONValue.string) ?? .null
        if case .object(let previous)? = prior, row.slug == nil, let slug = previous["projectSlug"] { entry["projectSlug"] = slug }
        recents.insert(.object(entry), at: 0)
        var changes: [String: JSONValue?] = [ProjectKey.recentWorkspaces: .array(Array(recents.prefix(ProjectKey.maxRecentWorkspaces)))]
        let isOpen = tabs.contains { if case .object(let tab) = $0, case .string(let id)? = tab["id"] { return id == row.id } else { return false } }
        if !isOpen {
            tabs.append(.object([
                "id": .string(row.id),
                "slug": row.slug.map(JSONValue.string) ?? .null,
                "name": .string(row.name),
                "workspacePath": .string(row.gitRepoPath),
            ]))
            changes[ProjectKey.openTabs] = .array(tabs)
        }
        try await writeUIState(changes)
        return row.summary
    }

    private static func recentPath(_ value: JSONValue) -> String? {
        guard case .object(let entry) = value, case .string(let path)? = entry["path"] else { return nil }
        return path
    }

    public func removeFromSidebar(projectID: String) async throws {
        var tabs: [JSONValue] = []
        locked { if case .array(let stored)? = uiState[ProjectKey.openTabs] { tabs = stored } }
        tabs.removeAll { if case .object(let tab) = $0, case .string(let id)? = tab["id"] { return id == projectID } else { return false } }
        try await writeUIState([ProjectKey.openTabs: .array(tabs)])
    }

    public func setBadgeColor(projectID: String, color: String?) async throws {
        let envelope = try await json(ProjectEnvelope.self, RawRequest(
            method: .post, path: RawRequest.path("rpc", "projects", projectID, "badge-color"), body: Self.body(BadgeColor(badgeColor: color))
        ))
        updateProjectRow(envelope.row)
    }

    /// The folder browser starts where the desktop's does: the directory listing's default (home).
    public func homeDirectory() async throws -> String { try await directory(nil).currentPath }

    public func listDirectory(path: String) async throws -> DirectoryListing {
        let response = try await directory(path)
        return DirectoryListing(
            path: response.currentPath,
            isGitRepository: response.isGitRepo,
            entries: response.entries.map { .init(name: $0.name, isDirectory: $0.isDirectory, isGitRepository: $0.isGitRepo) }
        )
    }
}
