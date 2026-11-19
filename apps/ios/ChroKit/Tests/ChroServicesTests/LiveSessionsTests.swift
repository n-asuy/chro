import ChroAPI
import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// SessionsService over the link: `/streams/tasks`, the archive, and starting
/// and continuing sessions with the desktop's routes and payloads.
@Suite(.timeLimit(.minutes(1)))
struct LiveSessionsTests {
    static let project = "11111111-0000-4000-8000-000000000001"
    static let general = "22222222-0000-4000-8000-000000000002"
    let desktop = FakeDesktop()

    init() {
        desktop.edit {
            $0.projects = [
                FakeDesktop.project(Self.project, name: "inventory-service", path: "/Users/me/inventory-service"),
                FakeDesktop.project(Self.general, name: "General", path: "/Users/me/.chro/chats", general: true),
            ]
            $0.tasks = [
                "aaaa0000-0000-4000-8000-000000000001": FakeDesktop.task("aaaa0000-0000-4000-8000-000000000001", project: Self.project, title: "Older", updatedAt: "2026-11-14T08:00:00.000Z"),
                "bbbb0000-0000-4000-8000-000000000002": FakeDesktop.task("bbbb0000-0000-4000-8000-000000000002", project: Self.project, title: "", status: "in_progress",
                                                                         updatedAt: "2026-11-14T09:30:00.000Z", active: "run-9", executor: nil, branch: "ch/bbbb-x"),
                "cccc0000-0000-4000-8000-000000000003": FakeDesktop.task("cccc0000-0000-4000-8000-000000000003", project: Self.project, title: "Archived", status: "cancelled"),
            ]
            $0.profile = ["executor": "CODEX"]
        }
    }

    private func listed(_ workspace: LiveWorkspace, _ count: Int) async throws -> [SessionSummary] {
        try await eventually("\(count) sessions") { workspace.sessionList.value.count == count }
        return workspace.sessionList.value
    }

    @Test func theListIsTheStreamsSnapshotWithoutArchivedTasksNewestFirst() async throws {
        let phone = try desktop.phone()
        let list = try await listed(phone.workspace, 2)
        #expect(list.map(\.id) == ["bbbb0000-0000-4000-8000-000000000002", "aaaa0000-0000-4000-8000-000000000001"])
        let running = list[0]
        #expect(running.shortID == "bbbb")
        #expect(running.title == nil)
        #expect(running.isRunning)
        #expect(running.status == "in_progress")
        #expect(running.branch == "ch/bbbb-x")
        #expect(running.projectID == Self.project)
        // Never ran: the agent is Settings → default agent.
        try await eventually("profile agent") { phone.workspace.sessionList.value.first?.agent == .codex }
        #expect(list[1].agent == .claudeCode)
        #expect(desktop.violations.isEmpty)
    }

    @Test func livePatchesAddReplaceAndRemoveRows() async throws {
        let phone = try desktop.phone()
        _ = try await listed(phone.workspace, 2)
        try await desktop.upsertTask(FakeDesktop.task("dddd0000-0000-4000-8000-000000000004", project: Self.project, title: "New", status: "pending", updatedAt: "2026-11-14T11:00:00.000Z"))
        try await eventually("added") { phone.workspace.sessionList.value.first?.title == "New" }
        try await desktop.upsertTask(FakeDesktop.task("aaaa0000-0000-4000-8000-000000000001", project: Self.project, title: "Renamed", updatedAt: "2026-11-14T08:00:00.000Z"))
        try await eventually("replaced") { phone.workspace.sessionList.value.contains { $0.title == "Renamed" } }
        try await desktop.removeTask("dddd0000-0000-4000-8000-000000000004")
        try await eventually("removed") { !phone.workspace.sessionList.value.contains { $0.title == "New" } }
        #expect(phone.workspace.sessionList.value.count == 2)
    }

    /// The host ending the task stream (a reply too large for an old host, a restart)
    /// keeps the rows until the next snapshot replaces them: an open session screen
    /// never loses its session while the stream starts over.
    @Test func aRestartedTaskStreamKeepsTheRowsUntilItsSnapshot() async throws {
        let phone = try desktop.phone()
        _ = try await listed(phone.workspace, 2)
        desktop.edit { $0.holdsTaskSnapshot = true }
        let responder = try #require(desktop.responders.last)
        let first = try #require(responder.subscriptions.first { $0.stream == "/streams/tasks" })
        try await responder.endSubscription(first.subscriptionId, error: ("reply_too_large", "a stream message exceeded 4194304 bytes"))
        try await eventually("subscribed again") {
            responder.subscriptions.contains { $0.stream == "/streams/tasks" && $0.subscriptionId != first.subscriptionId }
        }
        try await Task.sleep(for: .milliseconds(300))
        #expect(phone.workspace.sessionList.value.count == 2)
        #expect(try await phone.workspace.task("aaaa0000-0000-4000-8000-000000000001").id == "aaaa0000-0000-4000-8000-000000000001")
        // The next snapshot replaces the rows.
        var tasks: [String: [String: Any]] = [:]
        desktop.edit {
            $0.tasks.removeValue(forKey: "aaaa0000-0000-4000-8000-000000000001")
            tasks = $0.tasks
        }
        try await desktop.publish(["op": "replace", "path": "/tasks", "value": tasks])
        _ = try await listed(phone.workspace, 1)
    }

    @Test func archiveCancelsALiveRunThenSetsCancelled() async throws {
        let phone = try desktop.phone()
        _ = try await listed(phone.workspace, 2)
        try await phone.workspace.archive(sessionID: "bbbb0000-0000-4000-8000-000000000002")
        let writes = desktop.requests.filter { $0.method != "GET" }
        #expect(writes.map(\.path) == ["/rpc/tasks/bbbb0000-0000-4000-8000-000000000002/cancel", "/rpc/tasks/bbbb0000-0000-4000-8000-000000000002/status"])
        #expect(writes[1].method == "PATCH")
        #expect(writes[1].bodyObject as? [String: String] == ["status": "cancelled"])
        #expect(phone.workspace.sessionList.value.map(\.id) == ["aaaa0000-0000-4000-8000-000000000001"])
        let archived = try await phone.workspace.archivedSessions(projectID: Self.project, matching: "", offset: 0).sessions
        #expect(archived.map(\.id) == ["bbbb0000-0000-4000-8000-000000000002", "cccc0000-0000-4000-8000-000000000003"])
        #expect(archived[0].archivedAt > archived[1].archivedAt)
    }

    @Test func archivingAnIdleSessionDoesNotCancel() async throws {
        let phone = try desktop.phone()
        _ = try await listed(phone.workspace, 2)
        try await phone.workspace.archive(sessionID: "aaaa0000-0000-4000-8000-000000000001")
        #expect(desktop.requests("POST", "/rpc/tasks/aaaa0000-0000-4000-8000-000000000001/cancel").isEmpty)
    }

    @Test func restoreReturnsTheTaskToPending() async throws {
        let phone = try desktop.phone()
        _ = try await listed(phone.workspace, 2)
        try await phone.workspace.restore(sessionID: "cccc0000-0000-4000-8000-000000000003")
        #expect(desktop.requests("PATCH", "/rpc/tasks/cccc0000-0000-4000-8000-000000000003/status").first?.bodyObject as? [String: String] == ["status": "pending"])
        #expect(phone.workspace.sessionList.value.contains { $0.id == "cccc0000-0000-4000-8000-000000000003" })
    }

    @Test func archivingAnUnknownSessionIsNotFound() async throws {
        let phone = try desktop.phone()
        _ = try await listed(phone.workspace, 2)
        await #expect(throws: ServiceError.notFound("Session")) { try await phone.workspace.archive(sessionID: "nope") }
    }

    // MARK: Starting

    @Test func startCreatesTheSessionThenStartsItWithTheComposersSettings() async throws {
        desktop.edit { $0.skills = [["id": "user:.claude/skills:chro", "name": "chro", "description": "d", "source": "user_claude", "source_label": "user:.claude/skills",
                                     "source_path": "~/.claude/skills/chro/SKILL.md", "base_dir": "~/.claude/skills/chro", "abs_dir": "/Users/me/.claude/skills/chro"]] }
        let phone = try desktop.phone()
        _ = try await listed(phone.workspace, 2)
        let photo = Data(repeating: 0x89, count: 900_000)
        let request = NewSessionRequest(
            projectID: Self.project, prompt: "  Add a stock check  ",
            runtime: RuntimeChoice(agent: .claudeCode, model: "Opus 5.5", effort: .high, speed: .fast),
            baseBranch: "main", useWorktree: true,
            references: [
                ComposerReference(kind: .file, label: "@stock.ts", target: "src/stock.ts"),
                ComposerReference(kind: .directory, label: "@src", target: "src"),
                ComposerReference(kind: .session, label: "@Older", target: "aaaa0000-0000-4000-8000-000000000001"),
                ComposerReference(kind: .skill, label: "#chro", target: "chro"),
                ComposerReference(kind: .image, label: "photo-1.png", target: "ph-1", imageData: photo),
            ]
        )
        let started = try await phone.workspace.startSession(request)

        let upload = try #require(desktop.requests("POST", "/rpc/images/upload").first?.upload)
        #expect(upload == .init(field: "image", fileName: "photo-1.png", contentType: "image/png", data: photo))
        #expect(desktop.requests("GET", "/rpc/skills").first?.query == ["workspace_path": "/Users/me/inventory-service"])

        let expectedPrompt = """
        <context>
        <file path="src/stock.ts" />
        <directory path="src" />
        <past_session task_id="aaaa0000-0000-4000-8000-000000000001">
        Referenced session. A summary is injected at execution time; run `chro session read aaaa0000-0000-4000-8000-000000000001 --format markdown` for the full transcript.
        </past_session>
        </context>
        <skills_context>
        <skill id="user:.claude/skills:chro" name="chro" />
        </skills_context>
        ![photo-1.png](.chro-images/photo-1.png)
        Add a stock check
        """
        let create = try #require(desktop.requests("POST", "/v1/sessions").first)
        let createBody = try #require(create.bodyObject as? [String: Any])
        #expect(createBody["project"] as? String == Self.project)
        #expect(createBody["start"] as? Bool == false)
        #expect(createBody["prompt"] as? String == expectedPrompt)
        #expect(create.requestId != nil)

        let message = try #require(desktop.requests("POST", "/rpc/tasks/5e550000-0000-4000-8000-000000000001/messages").first?.bodyObject as? [String: Any])
        #expect(message["prompt"] as? String == expectedPrompt)
        #expect(message["mode"] as? String == "auto")
        #expect((message["executor_profile_id"] as? [String: String]) == ["executor": "CLAUDE_CODE", "model": "opus", "reasoning_effort": "high", "speed": "fast"])
        #expect(message["image_ids"] as? [String] == ["img-900000"])
        #expect(message["use_worktree"] as? Bool == true)
        #expect(message["target_branch"] as? String == "main")
        #expect(message["selected_skill_ids"] as? [String] == ["user:.claude/skills:chro"])
        let refs = try #require(message["context_refs"] as? [[String: String]])
        #expect(refs == [["kind": "file", "path": "src/stock.ts", "mode": "link"], ["kind": "directory", "path": "src", "mode": "link"],
                         ["kind": "session", "task_id": "aaaa0000-0000-4000-8000-000000000001", "mode": "transcript"]])

        #expect(started.id == "5e550000-0000-4000-8000-000000000001")
        #expect(started.isRunning)
        #expect(started.agent == .claudeCode)
        #expect(started.model == "Opus 5.5")
        #expect(started.projectID == Self.project)
        #expect(desktop.violations.isEmpty)
    }

    @Test func aScratchChatStartsWithoutWorktreeOrBranchAndWithTheDefaultModel() async throws {
        let phone = try desktop.phone()
        _ = try await listed(phone.workspace, 2)
        _ = try await phone.workspace.startSession(NewSessionRequest(projectID: Self.general, prompt: "hi", runtime: RuntimeChoice(agent: .codex), baseBranch: nil, useWorktree: false))
        let message = try #require(desktop.requests.last?.bodyObject as? [String: Any])
        #expect(message["use_worktree"] as? Bool == false)
        #expect(message["target_branch"] == nil)
        #expect(message["image_ids"] == nil)
        #expect((message["executor_profile_id"] as? [String: String]) == ["executor": "CODEX"])
        #expect(message["prompt"] as? String == "hi")
    }

    @Test func anEmptyPromptIsRefusedBeforeAnyCall() async throws {
        let phone = try desktop.phone()
        _ = try await listed(phone.workspace, 2)
        await #expect(throws: ServiceError.invalid("A prompt is required.")) {
            try await phone.workspace.startSession(NewSessionRequest(projectID: Self.project, prompt: "  ", runtime: RuntimeChoice(agent: .codex), baseBranch: nil, useWorktree: false))
        }
        #expect(desktop.requests("POST", "/v1/sessions").isEmpty)
    }

    // MARK: Continuing

    @Test func continueForksWithTheWorkspaceChoiceAndMarksTheForkViewed() async throws {
        let phone = try desktop.phone()
        _ = try await listed(phone.workspace, 2)
        let fork = try await phone.workspace.continueSession(sessionID: "aaaa0000-0000-4000-8000-000000000001", in: .newWorktree)
        #expect(desktop.requests("POST", "/rpc/tasks/aaaa0000-0000-4000-8000-000000000001/fork").first?.bodyObject as? [String: String] == ["workspace": "new_worktree"])
        #expect(fork.title == "Older (2)")
        #expect(fork.status == "pending")
        #expect(phone.workspace.sessionList.value.contains { $0.id == fork.id })
        let read = try #require(desktop.requests("PUT", "/rpc/ui-state").last?.bodyObject as? [String: Any])
        #expect((read[SessionListPreferences.Key.viewedAt] as? [String: String])?[fork.id] != nil)
    }

    @Test func aGeneralChatForksWithoutAWorkspace() async throws {
        desktop.edit { $0.tasks["eeee0000-0000-4000-8000-000000000005"] = FakeDesktop.task("eeee0000-0000-4000-8000-000000000005", project: Self.general, title: "Chat") }
        let phone = try desktop.phone()
        _ = try await listed(phone.workspace, 3)
        try await eventually("projects") { !phone.workspace.projectState.value.scratchProjectIDs.isEmpty }
        _ = try await phone.workspace.continueSession(sessionID: "eeee0000-0000-4000-8000-000000000005", in: .sameCheckout)
        #expect((desktop.requests("POST", "/rpc/tasks/eeee0000-0000-4000-8000-000000000005/fork").first?.bodyObject as? [String: Any])?.isEmpty == true)
    }

    @Test func aFailedForkShowsTheDesktopsToast() async throws {
        desktop.edit { $0.failures["/rpc/tasks/aaaa0000-0000-4000-8000-000000000001/fork"] = (409, "the session is running") }
        let phone = try desktop.phone()
        _ = try await listed(phone.workspace, 2)
        await #expect(throws: ServiceError.refused("Could not continue in a new session")) {
            try await phone.workspace.continueSession(sessionID: "aaaa0000-0000-4000-8000-000000000001", in: .sameCheckout)
        }
    }
}
