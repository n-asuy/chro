import ChroDomain
import Foundation

/// The Skills screen (skills/skills-panel.tsx).
public protocol SkillsService: Sendable {
    /// `GET /rpc/skills?workspace_path=`: the workspace's skills (when a path
    /// is given) and the user's global ones.
    func skills(workspacePath: String?) async throws -> [SkillPackage]
    /// `GET /rpc/preferences` → `show_hidden_entries`: whether the file tree
    /// shows dot-folders, so a skill under `.claude` can be revealed there.
    func showsHiddenEntries() async throws -> Bool
}
