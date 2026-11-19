import Foundation

/// Where a skill is defined (crates/skills `SkillSource`).
public enum SkillSource: String, Equatable, Sendable, CaseIterable {
    case workspaceClaude = "workspace_claude"
    case workspaceAgents = "workspace_agents"
    case workspaceChro = "workspace_chro"
    case userClaude = "user_claude"
    case userAgents = "user_agents"
    case userCodex = "user_codex"
}

/// Whether a skill lives in the workspace or the user's home (lib/skill-client.ts).
public enum SkillScope: String, Equatable, Sendable, CaseIterable {
    case workspace, user

    public var label: String { self == .workspace ? "Workspace" : "User" }
}

/// The agent ecosystem a skill targets, collapsed from the six sources.
public enum SkillProvider: String, Equatable, Sendable, CaseIterable {
    case claude, codex, agents

    public var label: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .agents: return "Agent Skills"
        }
    }
}

/// One entry of `GET /rpc/skills`.
public struct SkillPackage: Equatable, Sendable, Identifiable, Hashable {
    public var id: String
    public var name: String
    public var description: String
    public var source: SkillSource
    /// Display path of the SKILL.md (relative where possible).
    public var sourcePath: String
    public var baseDir: String
    /// Absolute path of the skill package directory on the desktop.
    public var absDir: String

    public init(id: String, name: String, description: String, source: SkillSource, sourcePath: String, baseDir: String, absDir: String) {
        self.id = id
        self.name = name
        self.description = description
        self.source = source
        self.sourcePath = sourcePath
        self.baseDir = baseDir
        self.absDir = absDir
    }

    public var scope: SkillScope { source.rawValue.hasPrefix("workspace_") ? .workspace : .user }

    public var provider: SkillProvider {
        switch source {
        case .workspaceClaude, .userClaude: return .claude
        case .userCodex: return .codex
        case .workspaceAgents, .userAgents, .workspaceChro: return .agents
        }
    }
}

/// The Skills screen's search and segmented filters; nil means "All".
public struct SkillFilter: Equatable, Sendable {
    public var query: String
    public var scope: SkillScope?
    public var provider: SkillProvider?

    public init(query: String = "", scope: SkillScope? = nil, provider: SkillProvider? = nil) {
        self.query = query
        self.scope = scope
        self.provider = provider
    }

    public func apply(_ skills: [SkillPackage]) -> [SkillPackage] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return skills.filter { skill in
            if let scope, skill.scope != scope { return false }
            if let provider, skill.provider != provider { return false }
            guard !needle.isEmpty else { return true }
            return [skill.name, skill.description, skill.sourcePath].contains { $0.lowercased().contains(needle) }
        }
    }
}

/// Rules of skills/skills-panel.tsx.
public enum SkillCatalog {
    /// The segment counts, computed from the listed skills.
    public struct Counts: Equatable, Sendable {
        public var workspace: Int
        public var user: Int
        public var providers: [SkillProvider: Int]

        public init(_ skills: [SkillPackage]) {
            workspace = skills.filter { $0.scope == .workspace }.count
            user = skills.count - workspace
            providers = skills.reduce(into: [:]) { $0[$1.provider, default: 0] += 1 }
        }

        /// Only providers that are present get a chip, in the desktop's order.
        public var presentProviders: [SkillProvider] { SkillProvider.allCases.filter { (providers[$0] ?? 0) > 0 } }
    }

    /// The file tree's virtual path (`/`-rooted) of a directory under the workspace, else nil.
    public static func treePath(absDir: String, workspacePath: String?) -> String? {
        guard let workspacePath else { return nil }
        let root = trimmed(workspacePath), dir = trimmed(absDir)
        if dir == root { return "/" }
        guard dir.hasPrefix(root + "/") else { return nil }
        let relative = dir.dropFirst(root.count + 1).drop { $0 == "/" }
        return relative.isEmpty ? "/" : "/" + relative
    }

    /// Where a card's tap reveals the skill in the file tree. Nil for user
    /// skills and for skills under a dot-folder while hidden entries are not
    /// shown: the desktop then opens the folder on disk, which the phone cannot.
    public static func revealPath(_ skill: SkillPackage, workspacePath: String?, showsHiddenEntries: Bool) -> String? {
        guard skill.scope == .workspace, let path = treePath(absDir: skill.absDir, workspacePath: workspacePath) else { return nil }
        if showsHiddenEntries { return path }
        return path.split(separator: "/").contains { $0.hasPrefix(".") } ? nil : path
    }

    private static func trimmed(_ path: String) -> String {
        var path = path.replacingOccurrences(of: "\\", with: "/")
        while path.hasSuffix("/") { path.removeLast() }
        return path
    }
}
