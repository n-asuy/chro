import ChroDomain
import Testing

@Suite struct SkillCatalogTests {
    private func skill(_ name: String, _ source: SkillSource, description: String = "", sourcePath: String = "", absDir: String = "") -> SkillPackage {
        SkillPackage(id: "\(source.rawValue):\(name)", name: name, description: description, source: source,
                     sourcePath: sourcePath, baseDir: "", absDir: absDir)
    }

    @Test func sourcesCollapseToScopeAndProvider() {
        #expect(skill("a", .workspaceClaude).scope == .workspace)
        #expect(skill("a", .workspaceChro).provider == .agents)
        #expect(skill("a", .userCodex).scope == .user)
        #expect(skill("a", .userCodex).provider == .codex)
        #expect(skill("a", .userAgents).provider == .agents)
        #expect(SkillScope.workspace.label == "Workspace")
        #expect(SkillProvider.agents.label == "Agent Skills")
    }

    @Test func countsComeFromTheList() {
        let skills = [skill("a", .workspaceClaude), skill("b", .userClaude), skill("c", .userClaude), skill("d", .userAgents)]
        let counts = SkillCatalog.Counts(skills)
        #expect(counts.workspace == 1)
        #expect(counts.user == 3)
        #expect(counts.providers == [.claude: 3, .agents: 1])
        // Only providers that are present get a chip, in the desktop's order.
        #expect(counts.presentProviders == [.claude, .agents])
    }

    @Test func filterMatchesNameDescriptionOrSourcePathCaseInsensitively() {
        let skills = [
            skill("restock-check", .workspaceClaude, description: "Check SKUs", sourcePath: ".claude/skills/restock-check/SKILL.md"),
            skill("agents-sdk", .userClaude, description: "Build AI agents"),
            skill("chro", .userCodex, description: "Drive sessions"),
        ]
        #expect(SkillFilter(query: "  SKUS ").apply(skills).map(\.name) == ["restock-check"])
        #expect(SkillFilter(query: "skill.md").apply(skills).map(\.name) == ["restock-check"])
        #expect(SkillFilter(scope: .user).apply(skills).map(\.name) == ["agents-sdk", "chro"])
        #expect(SkillFilter(scope: .user, provider: .codex).apply(skills).map(\.name) == ["chro"])
        #expect(SkillFilter(query: "zzz").apply(skills).isEmpty)
    }

    @Test func treePathIsRelativeToTheWorkspace() {
        #expect(SkillCatalog.treePath(absDir: "/w/repo/.claude/skills/x", workspacePath: "/w/repo/") == "/.claude/skills/x")
        #expect(SkillCatalog.treePath(absDir: "/w/repo", workspacePath: "/w/repo") == "/")
        #expect(SkillCatalog.treePath(absDir: "/home/u/.claude/skills/x", workspacePath: "/w/repo") == nil)
        #expect(SkillCatalog.treePath(absDir: "/w/repository/x", workspacePath: "/w/repo") == nil)
        #expect(SkillCatalog.treePath(absDir: "/w/repo/x", workspacePath: nil) == nil)
    }

    @Test func onlyWorkspaceSkillsOutsideDotFoldersRevealUnlessHiddenEntriesShow() {
        let dotted = skill("r", .workspaceClaude, absDir: "/w/repo/.claude/skills/r")
        let plain = skill("p", .workspaceChro, absDir: "/w/repo/skills/p")
        let user = skill("u", .userClaude, absDir: "/w/repo/skills/u")
        #expect(SkillCatalog.revealPath(dotted, workspacePath: "/w/repo", showsHiddenEntries: false) == nil)
        #expect(SkillCatalog.revealPath(dotted, workspacePath: "/w/repo", showsHiddenEntries: true) == "/.claude/skills/r")
        #expect(SkillCatalog.revealPath(plain, workspacePath: "/w/repo", showsHiddenEntries: false) == "/skills/p")
        #expect(SkillCatalog.revealPath(user, workspacePath: "/w/repo", showsHiddenEntries: true) == nil)
    }
}
