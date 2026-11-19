import ChroAPI
import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// UI state, projects, composer and onboarding over the link, with the
/// desktop's endpoints and value formats.
@Suite(.timeLimit(.minutes(1)))
struct LiveWorkspaceTests {
    static let inventory = "11111111-0000-4000-8000-000000000001"
    static let pricing = "33333333-0000-4000-8000-000000000003"
    static let general = "22222222-0000-4000-8000-000000000002"
    let desktop = FakeDesktop()

    init() {
        desktop.edit {
            $0.projects = [
                FakeDesktop.project(Self.inventory, name: "inventory-service", path: "/Users/me/inventory-service", badge: "teal"),
                FakeDesktop.project(Self.pricing, name: "pricing-notes", path: "/Users/me/pricing-notes"),
                FakeDesktop.project(Self.general, name: "General", path: "/Users/me/.chro/chats", general: true),
            ]
            $0.uiState = [
                "chro.openProjectTabs": [["id": Self.inventory, "slug": NSNull(), "name": "inventory-service", "workspacePath": "/Users/me/inventory-service"]],
                "chro.recentWorkspaces": [
                    ["path": "/Users/me/pricing-notes", "lastOpenedAt": 1_763_100_000_000, "projectId": Self.pricing, "projectName": "pricing-notes"],
                    ["path": "/Users/me/inventory-service/", "lastOpenedAt": 1_763_000_000_000],
                ],
                SessionListPreferences.Key.pins: ["t1": "2026-11-14T09:00:00.000Z"],
                SessionListPreferences.Key.viewedAt: ["t1": "2026-11-14T09:30:00.000Z", "t2": "2026-11-14T08:00:00Z"],
                SessionListPreferences.Key.sortMode: "name-desc",
                SessionListPreferences.Key.collapsedSections: ["chats", "pinned"],
            ]
        }
    }

    private func connected() async throws -> FakeDesktop.Phone {
        let phone = try desktop.phone(now: { Date(timeIntervalSince1970: 1_800_000_000) })
        try await eventually("shared state loaded") {
            phone.workspace.projectState.value.openProjects.first?.badgeColor == "teal"
                && phone.workspace.preferenceState.value.sortMode == .nameDescending
        }
        return phone
    }

    private func lastUIStateWrite() -> [String: Any]? {
        desktop.requests("PUT", "/rpc/ui-state").last?.bodyObject as? [String: Any]
    }

    // MARK: UI state

    @Test func preferencesAreTheDesktopsKeys() async throws {
        let phone = try await connected()
        let preferences = phone.workspace.preferenceState.value
        #expect(preferences.pins == ["t1": Date(timeIntervalSince1970: 1_794_646_800)])
        #expect(preferences.viewedAt["t1"] == Date(timeIntervalSince1970: 1_794_648_600))
        #expect(preferences.viewedAt["t2"] == Date(timeIntervalSince1970: 1_794_643_200))
        #expect(preferences.collapsedSections == [.chats, .pinned])
        #expect(preferences.nestDelegations == false)
    }

    @Test func pinningWritesAnISOTimeAndUnpinningRemovesIt() async throws {
        let phone = try await connected()
        await phone.workspace.togglePin(sessionID: "t2")
        #expect((lastUIStateWrite()?[SessionListPreferences.Key.pins] as? [String: String]) == ["t1": "2026-11-14T09:00:00.000Z", "t2": "2027-01-15T08:00:00.000Z"])
        #expect(phone.workspace.preferenceState.value.pins["t2"] == Date(timeIntervalSince1970: 1_800_000_000))
        await phone.workspace.togglePin(sessionID: "t1")
        #expect((lastUIStateWrite()?[SessionListPreferences.Key.pins] as? [String: String]) == ["t2": "2027-01-15T08:00:00.000Z"])
        #expect(desktop.violations.isEmpty)
    }

    @Test func theReadWatermarkOnlyMovesForward() async throws {
        let phone = try await connected()
        await phone.workspace.markViewed(sessionID: "t2")
        #expect((lastUIStateWrite()?[SessionListPreferences.Key.viewedAt] as? [String: String])?["t2"] == "2027-01-15T08:00:00.000Z")
        let writes = desktop.requests("PUT", "/rpc/ui-state").count
        desktop.edit { $0.uiState[SessionListPreferences.Key.viewedAt] = ["t3": "2030-01-01T00:00:00.000Z"] }
        await phone.workspace.reloadUIState()
        await phone.workspace.markViewed(sessionID: "t3")
        #expect(desktop.requests("PUT", "/rpc/ui-state").count == writes)
    }

    @Test func sortModeAndCollapsedSections() async throws {
        let phone = try await connected()
        await phone.workspace.setSortMode(.recent)
        #expect(lastUIStateWrite()?[SessionListPreferences.Key.sortMode] as? String == "recent")
        await phone.workspace.setCollapsedSections([.chats, .projects])
        #expect(lastUIStateWrite()?[SessionListPreferences.Key.collapsedSections] as? [String] == ["projects", "chats"])
        #expect(phone.workspace.preferenceState.value.collapsedSections == [.chats, .projects])
    }

    @Test func aRefusedWriteReloadsTheServersState() async throws {
        let phone = try await connected()
        desktop.edit { $0.failures["/rpc/ui-state"] = (500, "disk full") }
        await phone.workspace.setSortMode(.recent)
        desktop.edit { $0.failures = [:] }
        await phone.workspace.reloadUIState()
        #expect(phone.workspace.preferenceState.value.sortMode == .nameDescending)
    }

    // MARK: Projects

    @Test func projectsComeFromTheOpenTabsRecentsAndRecords() async throws {
        let phone = try await connected()
        let state = phone.workspace.projectState.value
        #expect(state.openProjects == [ProjectSummary(id: Self.inventory, name: "inventory-service", path: "/Users/me/inventory-service", badgeColor: "teal")])
        #expect(state.recents.map(\.id) == [Self.pricing, Self.inventory])
        #expect(state.scratchProjectIDs == [Self.general])
    }

    /// A host where no chat was ever started has no General project yet; the desktop
    /// creates it when New chat is pressed (use-new-chat.ts), so the phone must too.
    @Test func newChatCreatesTheGeneralProjectOnAHostWithoutOne() async throws {
        desktop.edit { $0.projects.removeAll { $0["is_general"] as? Bool == true } }
        let phone = try await connected()
        #expect(phone.workspace.projectState.value.scratchProjectIDs.isEmpty)
        let id = try await phone.workspace.ensureScratchProject()
        #expect(desktop.requests("POST", "/rpc/projects/general").count == 1)
        #expect(phone.workspace.projectState.value.scratchProjectIDs == [id])
    }

    @Test func newChatReusesTheKnownGeneralProject() async throws {
        let phone = try await connected()
        #expect(try await phone.workspace.ensureScratchProject() == Self.general)
        #expect(desktop.requests("POST", "/rpc/projects/general").isEmpty)
    }

    @Test func openingAWorkspaceEnsuresItAndRecordsItLikeTheDesktop() async throws {
        let phone = try await connected()
        let opened = try await phone.workspace.openWorkspace(path: "/Users/me/pricing-notes")
        #expect(desktop.requests("POST", "/rpc/projects/ensure").first?.bodyObject as? [String: String] == ["git_repo_path": "/Users/me/pricing-notes"])
        #expect(opened.id == Self.pricing)
        let write = try #require(lastUIStateWrite())
        let recents = try #require(write["chro.recentWorkspaces"] as? [[String: Any]])
        #expect(recents.map { $0["path"] as? String } == ["/Users/me/pricing-notes", "/Users/me/inventory-service/"])
        #expect(recents[0]["lastOpenedAt"] as? Int == 1_800_000_000_000)
        #expect(recents[0]["projectId"] as? String == Self.pricing)
        let tabs = try #require(write["chro.openProjectTabs"] as? [[String: Any]])
        #expect(tabs.map { $0["id"] as? String } == [Self.inventory, Self.pricing])
        #expect(tabs[1]["workspacePath"] as? String == "/Users/me/pricing-notes")
        #expect(phone.workspace.projectState.value.openProjects.map(\.id) == [Self.inventory, Self.pricing])
    }

    /// The desktop sends the folder as typed and the server matches records by the exact
    /// string, so a trailing slash ensures another record; only the recents list treats
    /// the two spellings as one folder.
    @Test func aTrailingSlashIsSentAsTypedAndRecentsTreatItAsTheSameFolder() async throws {
        let phone = try await connected()
        let opened = try await phone.workspace.openWorkspace(path: "/Users/me/pricing-notes/")
        #expect(desktop.requests("POST", "/rpc/projects/ensure").first?.bodyObject as? [String: String] == ["git_repo_path": "/Users/me/pricing-notes/"])
        #expect(opened.id != Self.pricing)
        let recents = try #require(lastUIStateWrite()?["chro.recentWorkspaces"] as? [[String: Any]])
        #expect(recents.map { $0["path"] as? String } == ["/Users/me/pricing-notes/", "/Users/me/inventory-service/"])
        #expect(recents[0]["projectId"] as? String == opened.id)
    }

    @Test func recentsKeepFive() async throws {
        let phone = try await connected()
        for index in 1...5 { _ = try await phone.workspace.openWorkspace(path: "/Users/me/repo-\(index)") }
        let recents = try #require(lastUIStateWrite()?["chro.recentWorkspaces"] as? [[String: Any]])
        #expect(recents.map { $0["path"] as? String } == (1...5).reversed().map { "/Users/me/repo-\($0)" })
    }

    @Test func removingFromTheSidebarOnlyClosesTheTab() async throws {
        let phone = try await connected()
        try await phone.workspace.removeFromSidebar(projectID: Self.inventory)
        #expect((lastUIStateWrite()?["chro.openProjectTabs"] as? [Any])?.isEmpty == true)
        #expect(phone.workspace.projectState.value.openProjects.isEmpty)
        #expect(phone.workspace.projectState.value.recents.count == 2)
    }

    @Test func badgeColours() async throws {
        let phone = try await connected()
        try await phone.workspace.setBadgeColor(projectID: Self.inventory, color: "red")
        #expect(desktop.requests("POST", "/rpc/projects/\(Self.inventory)/badge-color").last?.bodyObject as? [String: String] == ["badge_color": "red"])
        #expect(phone.workspace.projectState.value.openProjects.first?.badgeColor == "red")
        try await phone.workspace.setBadgeColor(projectID: Self.inventory, color: nil)
        let cleared = try #require(desktop.requests("POST", "/rpc/projects/\(Self.inventory)/badge-color").last?.bodyObject as? [String: Any])
        #expect(cleared["badge_color"] is NSNull)
        #expect(phone.workspace.projectState.value.openProjects.first?.badgeColor == nil)
    }

    @Test func theFolderBrowserListsTheDesktopsDirectories() async throws {
        desktop.edit {
            $0.directories = [
                "/Users/me": ["current_path": "/Users/me", "is_git_repo": false, "entries": [
                    ["name": "inventory-service", "path": "/Users/me/inventory-service", "is_directory": true, "is_git_repo": true],
                    ["name": "notes.md", "path": "/Users/me/notes.md", "is_directory": false, "is_git_repo": false],
                ]],
            ]
        }
        let phone = try await connected()
        #expect(try await phone.workspace.homeDirectory() == "/Users/me")
        #expect(desktop.requests("GET", "/rpc/filesystem/directory").first?.query == [:])
        let listing = try await phone.workspace.listDirectory(path: "/Users/me")
        #expect(listing == DirectoryListing(path: "/Users/me", isGitRepository: false, entries: [
            .init(name: "inventory-service", isDirectory: true, isGitRepository: true), .init(name: "notes.md", isDirectory: false),
        ]))
        await #expect(throws: ServiceError.unavailable("Failed to load directory")) { try await phone.workspace.listDirectory(path: "/nope") }
    }

    // MARK: Composer

    @Test func modelsAreTheDesktopsPresetsPlusPi() async throws {
        desktop.edit { $0.piModels = [["value": "anthropic/claude-x", "label": "Claude X", "provider": "anthropic"]] }
        let phone = try await connected()
        let models = try await phone.workspace.models()
        #expect(models.count == 13)
        #expect(models.first?.value == "fable")
        #expect(models.last == ModelOption(label: "Claude X", value: "anthropic/claude-x", agent: .pi, description: "anthropic", efforts: [], supportsFastSpeed: false))
    }

    @Test func theDefaultRuntimeIsTheProfileWithTheModelsLabel() async throws {
        desktop.edit { $0.profile = ["executor": "CLAUDE_CODE", "model": "opus", "reasoning_effort": "xhigh", "speed": "fast"] }
        let phone = try await connected()
        #expect(try await phone.workspace.defaultRuntime() == RuntimeChoice(agent: .claudeCode, model: "Opus 5.5", effort: .xhigh, speed: .fast))
        desktop.edit { $0.profile = ["executor": "PI"] }
        #expect(try await phone.workspace.defaultRuntime() == RuntimeChoice(agent: .pi))
    }

    @Test func branchesAreLocalWithTheCurrentFirst() async throws {
        desktop.edit {
            $0.branches = [
                ["name": "feature", "is_current": false, "is_remote": false, "last_commit_timestamp": 1],
                ["name": "origin/main", "is_current": false, "is_remote": true],
                ["name": "main", "is_current": true, "is_remote": false],
            ]
        }
        let phone = try await connected()
        #expect(try await phone.workspace.branches(projectID: Self.inventory) == [BranchOption(name: "main", isCurrent: true), BranchOption(name: "feature")])
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.inventory)/git/branches").count == 1)
    }

    @Test func skillsShowTheDesktopsSourceLabel() async throws {
        desktop.edit {
            $0.skills = [
                ["id": "user:.claude/skills:chro", "name": "chro", "description": "Drive chro", "source": "user_claude"],
                ["id": "workspace:skills:x", "name": "x", "description": "", "source": "workspace_chro"],
            ]
        }
        let phone = try await connected()
        #expect(try await phone.workspace.skills(projectID: Self.inventory) == [
            SkillSummary(name: "chro", description: "Drive chro", source: "~/.claude"), SkillSummary(name: "x", description: "", source: "workspace"),
        ])
        #expect(desktop.requests("GET", "/rpc/skills").first?.query == ["workspace_path": "/Users/me/inventory-service"])
    }

    @Test func filesSearchByNameOrSuggestTheTopFiles() async throws {
        desktop.edit {
            $0.searchResults = [
                ["path": "src/stock.ts", "is_file": true, "match_type": "FileName", "line_matches": []],
                ["path": "src", "is_file": false, "match_type": "DirectoryName", "line_matches": []],
            ]
        }
        let phone = try await connected()
        #expect(try await phone.workspace.files(projectID: Self.inventory, query: " sto ") == ["src/stock.ts"])
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.inventory)/search").last?.query == ["q": "sto"])
        _ = try await phone.workspace.files(projectID: Self.inventory, query: "")
        #expect(desktop.requests("GET", "/rpc/projects/\(Self.inventory)/search").last?.query == ["q": "", "files_only": "true", "limit": "5"])
    }

    // MARK: Onboarding

    @Test func installStatusDefaultAgentAndTheCompletionFlag() async throws {
        desktop.edit {
            $0.installStatus = [
                "claude_code": ["installed": true, "command": "claude", "resolved_path": "/bin/claude", "detected_version": "2.1.323"],
                "codex": ["installed": false, "command": "codex"],
                "pi": ["installed": true, "command": "pi"],
                "git": ["installed": true, "command": "git", "detected_version": "2.43.0"],
            ]
        }
        let phone = try await connected()
        let status = try await phone.workspace.installStatus()
        #expect(status == InstallStatus(git: .installed(version: "2.43.0"), agents: [
            .claudeCode: .installed(version: "2.1.323"), .codex: .notInstalled, .pi: .installed(version: nil),
        ]))

        try await phone.workspace.setDefaultAgent(.codex)
        let profile = try #require(desktop.requests("PUT", "/rpc/executor/profile").first?.bodyObject as? [String: Any])
        #expect(profile["executor"] as? String == "CODEX")
        #expect(profile["variant"] is NSNull)
        #expect(Set(profile.keys) == ["executor", "variant"])

        #expect(try await phone.workspace.isOnboardingComplete() == false)
        try await phone.workspace.completeOnboarding()
        #expect(lastUIStateWrite()?["chro:setup-onboarding-complete"] as? Bool == true)
        #expect(try await phone.workspace.isOnboardingComplete())
        #expect(desktop.violations.isEmpty)
    }

    @Test func aRefusedEndpointSurfacesAsUnavailable() async throws {
        let phone = try await connected()
        await #expect(throws: ServiceError.unavailable("this endpoint is not available to paired devices")) {
            _ = try await phone.workspace.json(ProjectsEnvelope.self, RawRequest(path: "/rpc/developer/x"))
        }
    }

    // MARK: Unknown outcomes

    @Test func aChangeWhoseAnswerWasLostHasAnUnknownOutcome() {
        for code in ["deadline_exceeded", "unreachable", "timeout"] {
            let error = APIError(code: ErrorCode(rawValue: code), message: "lost")
            #expect(LiveWorkspace.serviceError(error, method: .post) == .outcomeUnknown("lost"))
            #expect(LiveWorkspace.serviceError(error, method: .put) == .outcomeUnknown("lost"))
            // A read changes nothing: it simply failed.
            #expect(LiveWorkspace.serviceError(error, method: .get) == .unavailable("lost"))
        }
        let refused = APIError(code: .notFound, message: "no such task")
        #expect(LiveWorkspace.serviceError(refused, method: .post) == .unavailable("no such task"))
        #expect(ServiceError.outcomeUnknown("lost").message == "lost")
        #expect(ServiceError.outcomeUnknown("lost").isOutcomeUnknown)
        #expect(!ServiceError.unavailable("lost").isOutcomeUnknown)
    }

    @Test func theDesktopsDeadlineOnAChangeIsAnUnknownOutcome() async throws {
        desktop.edit { $0.rpcErrors["PUT /rpc/ui-state"] = ("deadline_exceeded", "the request did not finish within 300 seconds") }
        let phone = try await connected()
        await #expect(throws: ServiceError.outcomeUnknown("the request did not finish within 300 seconds")) {
            try await phone.workspace.send(RawRequest(method: .put, path: "/rpc/ui-state", body: Data("{}".utf8)))
        }
    }
}
