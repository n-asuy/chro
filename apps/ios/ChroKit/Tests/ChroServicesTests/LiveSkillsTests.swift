import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// SkillsService over the link: `/rpc/skills` and the hidden-entries preference.
@Suite(.timeLimit(.minutes(1)))
struct LiveSkillsTests {
    let desktop = FakeDesktop()

    @Test func skillsOfTheWorkspaceAndTheUser() async throws {
        desktop.reply("GET /rpc/skills", ["skills": [
            ["id": "w1", "name": "restock-check", "description": "Check SKUs.", "source": "workspace_claude", "source_label": ".claude",
             "source_path": ".claude/skills/restock-check/SKILL.md", "base_dir": ".claude/skills", "abs_dir": "/repo/.claude/skills/restock-check"],
            ["id": "u1", "name": "future", "description": "", "source": "user_newtool", "source_label": "?", "source_path": "x", "base_dir": "x", "abs_dir": "x"],
        ]])
        desktop.reply("GET /rpc/preferences", ["preferences": ["language": "en", "show_hidden_entries": true, "analytics_enabled": true, "telemetry_id": "t"]])
        let skills = SkillsLiveService(calls: try await desktop.panelPhone().calls)
        #expect(try await skills.skills(workspacePath: " /repo ") == [
            SkillPackage(id: "w1", name: "restock-check", description: "Check SKUs.", source: .workspaceClaude,
                         sourcePath: ".claude/skills/restock-check/SKILL.md", baseDir: ".claude/skills", absDir: "/repo/.claude/skills/restock-check"),
        ])
        #expect(desktop.requests("GET", "/rpc/skills").first?.query == ["workspace_path": "/repo"])
        _ = try await skills.skills(workspacePath: nil)
        #expect(desktop.requests("GET", "/rpc/skills").last?.query == [:])
        #expect(try await skills.showsHiddenEntries())
    }
}
