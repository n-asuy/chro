import ChroDomain
import Foundation

/// SkillsService with the cards the second capture showed (mock SKILL_CARDS).
///
/// Hand-completed and disclosed: the capture showed four cards out of 174
/// skills and their descriptions only as the card's three clamped lines, so
/// the three user skills carry the visible text (ending in "…"). Their
/// `sourcePath` and `absDir` are written under `~` because the host's home
/// directory was not captured. The screen derives its counts from this list
/// (as the desktop does), so they read 1 workspace / 3 user, not the
/// captured totals.
final class SkillsFixtureService: SkillsService, @unchecked Sendable {
    private let scenario: FixtureScenario

    init(scenario: FixtureScenario) { self.scenario = scenario }

    func skills(workspacePath: String?) async throws -> [SkillPackage] {
        var skills: [SkillPackage] = []
        if let workspacePath {
            let root = workspacePath.hasSuffix("/") ? String(workspacePath.dropLast()) : workspacePath
            skills.append(SkillPackage(
                id: "workspace:.claude/skills:restock-check", name: "restock-check",
                description: "Check which SKUs fall below their reorder point and draft a restock list. Use when asked about low stock or restocking.",
                source: .workspaceClaude, sourcePath: ".claude/skills/restock-check/SKILL.md",
                baseDir: ".claude/skills/restock-check", absDir: root + "/.claude/skills/restock-check"))
        }
        return skills + Self.userSkills
    }

    func showsHiddenEntries() async throws -> Bool { false }

    private static let userSkills: [SkillPackage] = [
        ("agent-browser", "AIエージェント向けのブラウザ自動化CLI。Webページ遷移、フォーム入力、クリック、スクリーンショット取得、データ抽出、Webアプリ検証、ログイン操作など、ブラ…"),
        ("agents-sdk", "Build AI agents on Cloudflare Workers using the Agents SDK. Load when creating stateful agents, durable workflows, real-time WebSocket apps, scheduled…"),
        ("amend-cli", "Use the `amend` CLI to drive AmendFS — browse records, author proposals, review/approve/apply them through the Apply Gateway, checkout an editable…"),
    ].map { name, description in
        SkillPackage(id: "user:.claude/skills:\(name)", name: name, description: description, source: .userClaude,
                     sourcePath: "~/.claude/skills/\(name)/SKILL.md", baseDir: "~/.claude/skills/\(name)", absDir: "~/.claude/skills/\(name)")
    }
}
