import ChroDomain
import Foundation

/// The workspace's projects as the left panel needs them.
public struct ProjectsState: Equatable, Sendable {
    /// Projects open in the sidebar, in the order they were opened.
    public var openProjects: [ProjectSummary]
    /// "Open another project": recently opened, newest first (at most five are shown).
    public var recents: [ProjectSummary]
    /// The hidden General project(s) that hold scratch chats.
    public var scratchProjectIDs: Set<String>

    public init(openProjects: [ProjectSummary], recents: [ProjectSummary], scratchProjectIDs: Set<String>) {
        self.openProjects = openProjects
        self.recents = recents
        self.scratchProjectIDs = scratchProjectIDs
    }

    public func project(_ id: String) -> ProjectSummary? {
        openProjects.first { $0.id == id } ?? recents.first { $0.id == id }
    }
}

/// GET /rpc/filesystem/directory.
public struct DirectoryListing: Equatable, Sendable {
    public struct Entry: Equatable, Sendable, Identifiable {
        public var name: String
        public var isDirectory: Bool
        public var isGitRepository: Bool
        public var id: String { name }
        public init(name: String, isDirectory: Bool, isGitRepository: Bool = false) {
            self.name = name
            self.isDirectory = isDirectory
            self.isGitRepository = isGitRepository
        }
    }

    public var path: String
    public var isGitRepository: Bool
    public var entries: [Entry]

    public init(path: String, isGitRepository: Bool, entries: [Entry]) {
        self.path = path
        self.isGitRepository = isGitRepository
        self.entries = entries
    }

    /// The parent of `path`, nil at the root.
    public static func parent(of path: String) -> String? {
        guard !path.isEmpty, path != "/" else { return nil }
        let trimmed = path.hasSuffix("/") ? String(path.dropLast()) : path
        guard let slash = trimmed.lastIndex(of: "/") else { return nil }
        let parent = String(trimmed[..<slash])
        return parent.isEmpty ? "/" : parent
    }
}

/// Projects of the paired desktop: the sidebar list, opening a folder as a
/// workspace (lib/open-workspace.ts), the folder browser, and per-project
/// sidebar settings.
public protocol ProjectsService: Sendable {
    func projects() -> AsyncStream<ProjectsState>
    /// Ensure a project for the folder, record it as recent and open it in the sidebar.
    func openWorkspace(path: String) async throws -> ProjectSummary
    /// The hidden General project that holds scratch chats, created on the host when it
    /// has none yet (use-new-chat.ts: New chat ensures it before opening the launcher).
    func ensureScratchProject() async throws -> String
    func removeFromSidebar(projectID: String) async throws
    func setBadgeColor(projectID: String, color: String?) async throws
    /// Where the folder browser starts.
    func homeDirectory() async throws -> String
    func listDirectory(path: String) async throws -> DirectoryListing
}

/// The preset badge colours of the project color picker (globals.css --color-project-*).
public enum ProjectBadgeColor: String, CaseIterable, Sendable {
    case neutral, red, orange, amber, green, teal, blue, purple, pink

    public var hex: String {
        switch self {
        case .neutral: return "#8B919C"
        case .red: return "#D25C55"
        case .orange: return "#D2793A"
        case .amber: return "#C99E38"
        case .green: return "#5AA860"
        case .teal: return "#45A49B"
        case .blue: return "#5B87D6"
        case .purple: return "#8A6AD2"
        case .pink: return "#CF6D9E"
        }
    }

    public var label: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }

    /// A stored value (preset name or hex) as hex.
    public static func resolve(_ stored: String?) -> String? {
        guard let stored else { return nil }
        return ProjectBadgeColor(rawValue: stored)?.hex ?? stored
    }
}
