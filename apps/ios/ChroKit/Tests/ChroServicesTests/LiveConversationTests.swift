import ChroAPI
import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// ConversationService over the link: the streams the desktop's session view
/// reads, assembled as it does, and its routes and bodies for every action.
@Suite(.timeLimit(.minutes(1)))
struct LiveConversationTests {
    static let project = "11111111-0000-4000-8000-000000000001"
    static let task = "aaaa0000-0000-4000-8000-000000000001"
    let desktop = FakeDesktop()

    private static func patch(_ path: String, _ value: Any, op: String = "replace") -> [String: Any] { ["op": op, "path": path, "value": value] }
    private static func snapshot(_ ops: [[String: Any]]) -> String { FakeDesktop.text(["type": "json_patch", "payload": ops]) }
    private static func log(_ ops: [[String: Any]]) -> String { FakeDesktop.text(["JsonPatch": ops]) }
    private static let finished = FakeDesktop.text(["finished": true])
    private static let replay = FakeDesktop.text(["replayStarted": true])

    static func run(_ id: String, status: String, at minute: Int, target: String = "main") -> [String: Any] {
        ["id": id, "task_id": task, "status": status, "created_at": String(format: "2026-11-14T09:%02d:00.000Z", minute), "target_branch": target,
         "container_ref": "/wt/\(id)", "executor_label": #"{"executor":"CLAUDE_CODE","variant":null,"model":"haiku","reasoning_effort":null}"#]
    }

    static func entry(_ type: String, _ content: String) -> [String: Any] {
        ["type": "NORMALIZED_ENTRY", "content": ["type": ["type": type], "content": content, "timestamp": NSNull()]]
    }

    static var question: [String: Any] { [
        "id": "ap-1", "task_run_id": "run-2", "tool_name": "AskUserQuestion", "status": ["status": "pending"],
        "tool_input": ["questions": [["question": "Which policy?", "header": "Policy", "multiSelect": false,
                                      "options": [["label": "Weekly", "description": "Every Monday"]]]]],
    ] }

    init() {
        desktop.edit { d in
            d.projects = [FakeDesktop.project(Self.project, name: "inventory-service", path: "/Users/me/inventory-service")]
            d.tasks = [Self.task: FakeDesktop.task(Self.task, project: Self.project, title: "Restock", status: "in_progress", active: "run-2", branch: "ch/aaaa-restock")]
            d.streamSnapshots = [
                FakeDesktop.streamKey("/streams/tasks/:task_id/runs", id: Self.task): [Self.snapshot([Self.patch("/task_runs", [
                    "run-1": Self.run("run-1", status: "completed", at: 1), "run-2": Self.run("run-2", status: "running", at: 2),
                ])])],
                FakeDesktop.streamKey("/streams/tasks/:task_id/sessions", id: Self.task): [Self.snapshot([Self.patch("/task_sessions", [
                    "s1": ["id": "s1", "task_run_id": "run-1", "prompt": "Count the stock"],
                    "s2": ["id": "s2", "task_run_id": "run-2", "prompt": "Ask me the policy"],
                ])])],
                FakeDesktop.streamKey("/streams/tasks/:task_id/queue", id: Self.task): [Self.snapshot([Self.patch("/session_queue", [
                    "q1": ["id": "q1", "task_id": Self.task, "prompt": "Then summarize", "seq": 1, "created_at": FakeDesktop.createdAt],
                ])])],
                FakeDesktop.streamKey("/streams/task-runs/:id/logs", id: "run-1"): [
                    Self.replay, Self.log([Self.patch("/entries/0", Self.entry("user_message", "raw"), op: "add"),
                                           Self.patch("/entries/1", Self.entry("assistant_message", "60 SKUs counted."), op: "add")]), Self.finished,
                ],
                FakeDesktop.streamKey("/streams/task-runs/:id/logs", id: "run-2"): [
                    Self.replay, Self.log([Self.patch("/entries/0", Self.entry("thinking", "Checking the policy"), op: "add"), Self.patch("/approvals/ap-1", Self.question, op: "add")]),
                ],
                FakeDesktop.streamKey("/rpc/task-runs/:id/diff", id: "run-2"): [Self.snapshot([Self.patch("/diffs", [
                    "src/stock.ts": ["type": "DIFF", "content": ["additions": 7, "deletions": 2]],
                ])])],
            ]
            d.replies = [
                "GET /rpc/tasks/\(Self.task)/runs": .json(status: 200, FakeDesktop.text(["runs": [Self.run("run-1", status: "completed", at: 1),
                                                                                                    Self.run("run-2", status: "running", at: 2)]])),
                "GET /rpc/task-runs/run-2/branch-status": .json(status: 200, FakeDesktop.text([
                    "commits_ahead": 1, "commits_behind": 3, "target_branch": "main", "is_rebase_in_progress": false, "merges": [], "conflicted_files": [], "conflict_op": NSNull(),
                ])),
                "GET /rpc/tasks/\(Self.task)/context-refs": .json(status: 200, FakeDesktop.text(["refs": [["task_id": Self.task, "kind": "file", "path": "src/stock.ts"]]])),
                "GET /rpc/tasks/\(Self.task)/referenced-by": .json(status: 200, FakeDesktop.text(["refs": [["task_id": "bbbb", "kind": "delegate", "target_task_id": Self.task]]])),
            ]
        }
    }

    /// Reads the conversation until `condition` holds.
    private func conversation(_ service: LiveWorkspace, _ what: String, id: String = task,
                              _ condition: @escaping @Sendable (SessionConversation) -> Bool) async throws -> SessionConversation {
        let box = Box()
        let reader = Task {
            for await value in service.conversation(sessionID: id) {
                box.set(value)
                if condition(value) { return }
            }
        }
        defer { reader.cancel() }
        try await eventually(what) { box.get().map(condition) ?? false }
        return box.get()!
    }

    private final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var value: SessionConversation?
        func set(_ value: SessionConversation) { lock.withLock { self.value = value } }
        func get() -> SessionConversation? { lock.withLock { value } }
    }

    @Test func theConversationIsAssembledFromTheDesktopsStreams() async throws {
        let phone = try desktop.phone()
        let c = try await conversation(phone.workspace, "assembled") { $0.entries.count == 5 && $0.pendingApproval != nil && $0.references.count == 2 && $0.branchStatus.additions == 7 && $0.branchStatus.commitsBehind == 3 }
        #expect(c.isLoaded)
        #expect(c.entries.map(\.id) == ["run-1:synthetic-user-s1", "run-1:stream-entry:1", "run-2:synthetic-user-s2", "run-2:stream-entry:0", "run-2:loading"])
        #expect(c.entries.map(\.kind) == [.userMessage("Count the stock"), .assistantMessage("60 SKUs counted."), .userMessage("Ask me the policy"), .thinking("Checking the policy"), .loading("")],
                "the running run trails the working sentinel the desktop adds; the server never sends one")
        #expect(c.pendingApproval == .question(approvalID: "ap-1", questions: [.init(question: "Which policy?", header: "Policy",
                                                                                         options: [.init(label: "Weekly", description: "Every Monday")], multiSelect: false)]))
        #expect(c.queue == [QueuedPrompt(id: "q1", prompt: "Then summarize")])
        #expect(c.runtime == RuntimeChoice(agent: .claudeCode, model: "Haiku 5.5"))
        #expect(c.hasRun)
        #expect(c.usesWorktree)
        #expect(c.branchStatus.targetBranch == "main")
        #expect(c.references == [.init(target: .session(id: "bbbb"), relation: .delegatedTo), .init(target: .path("src/stock.ts", isDirectory: false), relation: .uses)])
        #expect(!c.hasEarlierHistory)
        #expect(desktop.violations.isEmpty)
    }

    /// Every value the conversation publishes until `condition` holds.
    private func values(_ service: LiveWorkspace, _ what: String, id: String = task,
                        until condition: @escaping @Sendable (SessionConversation) -> Bool) async throws -> [SessionConversation] {
        let log = ValueLog()
        let reader = Task {
            for await value in service.conversation(sessionID: id) {
                log.append(value)
                if condition(value) { return }
            }
        }
        defer { reader.cancel() }
        try await eventually(what) { log.all.last.map(condition) ?? false }
        return log.all
    }

    private final class ValueLogBox: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [SessionConversation] = []
        func append(_ value: SessionConversation) { lock.withLock { values.append(value) } }
        var all: [SessionConversation] { lock.withLock { values } }
        var last: SessionConversation? { lock.withLock { values.last } }
    }

    private final class ValueLog: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [SessionConversation] = []
        func append(_ value: SessionConversation) { lock.withLock { values.append(value) } }
        var all: [SessionConversation] { lock.withLock { values } }
    }

    /// Found on a real server: the composer latched the placeholder published before the
    /// runs arrived, so every session's pill read "Claude Code" instead of its model.
    @Test func theComposerSeedWaitsForTheRunsAndIsTheLatestRunsRuntime() async throws {
        let phone = try desktop.phone()
        let seen = try await values(phone.workspace, "loaded") { $0.isLoaded }
        #expect(seen.first?.composerSeed == nil, "the placeholder seeds nothing")
        #expect(seen.compactMap(\.composerSeed) == [RuntimeChoice(agent: .claudeCode, model: "Haiku 5.5")])
    }

    @Test func aSessionWithoutRunsSeedsTheHostsDefaultRuntime() async throws {
        desktop.edit { d in
            d.profile["executor"] = "CODEX"
            d.streamSnapshots[FakeDesktop.streamKey("/streams/tasks/:task_id/runs", id: Self.task)] = [Self.snapshot([Self.patch("/task_runs", [String: Any]())])]
        }
        let phone = try desktop.phone()
        let seen = try await values(phone.workspace, "loaded") { $0.isLoaded }
        #expect(seen.compactMap(\.composerSeed).first?.agent == .codex)
        #expect(seen.last?.hasRun == false)
    }

    @Test func liveLogPatchesReachTheConversation() async throws {
        let phone = try desktop.phone()
        let box = Box()
        let reader = Task { for await value in phone.workspace.conversation(sessionID: Self.task) { box.set(value) } }
        defer { reader.cancel() }
        try await eventually("loaded") { box.get()?.entries.count == 5 && box.get()?.pendingApproval != nil }
        try await desktop.push("/streams/task-runs/:id/logs", id: "run-2", ["JsonPatch": [
            Self.patch("/entries/0", Self.entry("assistant_message", "Which policy should I use?")),
            Self.patch("/approvals/ap-1", Self.question.merging(["status": ["status": "approved"]]) { $1 }),
        ]])
        try await eventually("patched") {
            box.get()?.entries.suffix(2).map(\.kind) == [.assistantMessage("Which policy should I use?"), .loading("")] && box.get()?.pendingApproval == nil
        }
    }

    private static let working: @Sendable (SessionConversation) -> Bool = { $0.entries.contains { $0.kind == .loading("") } }

    /// use-conversation-history.ts: the running run's log stream is live until its
    /// `finished` marker, and only that run carries the sentinel.
    @Test func theWorkingSentinelTrailsTheRunningRunUntilItsLogFinishes() async throws {
        let phone = try desktop.phone()
        let box = Box()
        let reader = Task { for await value in phone.workspace.conversation(sessionID: Self.task) { box.set(value) } }
        defer { reader.cancel() }
        try await eventually("live") { box.get()?.entries.count == 5 }
        #expect(box.get()?.entries.filter { $0.kind == .loading("") }.map(\.runID) == ["run-2"], "the finished run-1 has none")
        try await desktop.push("/streams/task-runs/:id/logs", id: "run-2", ["finished": true])
        try await eventually("finished") { box.get().map { !Self.working($0) && $0.entries.count == 4 } ?? false }
    }

    /// The desktop keeps streaming after the runs stream turns the run terminal:
    /// a cleanup race can publish the status before the log ends.
    @Test func theSentinelOutlivesATerminalStatusUntilTheLogFinishes() async throws {
        let phone = try desktop.phone()
        let seen = ValueLogBox()
        let reader = Task { for await value in phone.workspace.conversation(sessionID: Self.task) { seen.append(value) } }
        defer { reader.cancel() }
        // The log is subscribed once its entry shows; a running run is live before that.
        try await eventually("live") { seen.last.map { Self.working($0) && $0.entries.count == 5 } ?? false }
        try await desktop.push("/streams/tasks/:task_id/runs", id: Self.task, ["type": "json_patch", "payload": [
            Self.patch("/task_runs/run-2", Self.run("run-2", status: "completed", at: 2)),
        ]])
        let before = seen.all.count
        try await eventually("the runs patch published") { seen.all.count > before }
        #expect(seen.last.map(Self.working) == true, "still live: the log has not finished")
        try await desktop.push("/streams/task-runs/:id/logs", id: "run-2", ["finished": true])
        try await eventually("finished") { seen.last.map { !Self.working($0) } ?? false }
    }

    /// A finished log is not live again while the runs stream still says running.
    @Test func aFinishedLogStaysFinishedWhileTheStatusLags() async throws {
        desktop.edit { d in
            d.streamSnapshots[FakeDesktop.streamKey("/streams/task-runs/:id/logs", id: "run-2")]?.append(Self.finished)
        }
        let phone = try desktop.phone()
        let seen = ValueLogBox()
        let reader = Task { for await value in phone.workspace.conversation(sessionID: Self.task) { seen.append(value) } }
        defer { reader.cancel() }
        // Each log replays its entries before its `finished` marker, so a value can
        // carry run-2's entries with the sentinel still on; wait for the settled one.
        try await eventually("replayed and finished") { seen.last.map { !Self.working($0) && $0.entries.count == 4 && $0.pendingApproval != nil } ?? false }
        let settled = seen.all.count
        try await Task.sleep(for: .milliseconds(200))
        #expect(!seen.all.dropFirst(settled - 1).contains(where: Self.working), "live again after its log finished")
        #expect(desktop.violations.isEmpty)
    }

    @Test func historyLoadsThreeFinishedRunsAtATime() async throws {
        var runs: [String: Any] = [:]
        var snapshots: [String: [String]] = [:]
        for index in 1...5 {
            runs["r\(index)"] = Self.run("r\(index)", status: "completed", at: index)
            snapshots[FakeDesktop.streamKey("/streams/task-runs/:id/logs", id: "r\(index)")] = [
                Self.log([Self.patch("/entries/0", Self.entry("assistant_message", "turn \(index)"), op: "add")]), Self.finished,
            ]
        }
        desktop.edit { d in
            d.streamSnapshots[FakeDesktop.streamKey("/streams/tasks/:task_id/runs", id: Self.task)] = [Self.snapshot([Self.patch("/task_runs", runs)])]
            d.streamSnapshots.merge(snapshots) { $1 }
        }
        let phone = try desktop.phone()
        let first = try await conversation(phone.workspace, "three runs") { $0.entries.count == 3 }
        #expect(first.entries.map(\.runID) == ["r3", "r4", "r5"])
        #expect(first.hasEarlierHistory)
        let box = Box()
        let reader = Task { for await value in phone.workspace.conversation(sessionID: Self.task) { box.set(value) } }
        defer { reader.cancel() }
        try await eventually("reading") { box.get()?.entries.count == 3 }
        await phone.workspace.loadEarlierHistory(sessionID: Self.task)
        try await eventually("five runs") { box.get()?.entries.count == 5 }
        #expect(box.get()?.hasEarlierHistory == false)
    }

    @Test func aContinuedSessionShowsItsSourceUpToTheAnchor() async throws {
        let source = "5005ce00-0000-4000-8000-000000000009"
        desktop.edit { d in
            d.replies["GET /rpc/tasks/\(Self.task)/context-refs"] = .json(status: 200, FakeDesktop.text(["refs": [[
                "task_id": Self.task, "kind": "fork", "target_task_id": source, "mode": "native", "label": "Count stock",
                "metadata_json": #"{"run_id":"src-1"}"#,
            ]]]))
            d.replies["GET /rpc/tasks/\(source)/runs"] = .json(status: 200, FakeDesktop.text(["runs": [
                ["id": "src-1", "status": "completed", "created_at": "2026-11-14T08:00:00Z"], ["id": "src-2", "status": "completed", "created_at": "2026-11-14T08:30:00Z"],
            ]]))
            d.streamSnapshots[FakeDesktop.streamKey("/streams/task-runs/:id/logs", id: "src-1")] = [
                Self.log([Self.patch("/entries/0", Self.entry("user_message", "Count"), op: "add"), Self.patch("/entries/1", Self.entry("assistant_message", "60"), op: "add")]),
                Self.finished,
            ]
        }
        let phone = try desktop.phone()
        let c = try await conversation(phone.workspace, "origin") { $0.continuation != nil }
        let origin = try #require(c.continuation)
        #expect(origin.sourceSessionID == source)
        #expect(origin.sourceTitle == "Count stock")
        #expect(origin.nativeEntries?.map(\.kind) == [.userMessage("Count"), .assistantMessage("60")])
        #expect(origin.nativeEntries?.allSatisfy { $0.isInherited } == true)
        #expect(c.references.first == .init(target: .session(id: source), relation: .continuedFrom))
    }

    @Test func actionsUseTheDesktopsRoutesAndBodies() async throws {
        desktop.edit { d in
            for route in ["POST /rpc/tasks/\(Self.task)/queue", "PATCH /rpc/tasks/\(Self.task)/queue/q1", "DELETE /rpc/tasks/\(Self.task)/queue/q1",
                          "PUT /rpc/tasks/\(Self.task)/queue", "POST /rpc/tasks/\(Self.task)/queue/q1/send", "POST /rpc/task-runs/run-2/cancel",
                          "POST /rpc/task-runs/run-2/conflicts/abort"] {
                d.replies[route] = .empty(status: 204)
            }
            d.replies["POST /rpc/approvals/ap-1/respond"] = .json(status: 200, FakeDesktop.text(["status": ["status": "approved"]]))
            var renamed = FakeDesktop.task(Self.task, project: Self.project, title: "Restock policy", status: "in_progress", active: "run-2")
            renamed["updated_at"] = FakeDesktop.createdAt
            d.replies["PATCH /rpc/tasks/\(Self.task)/title"] = .json(status: 200, FakeDesktop.text(["task": renamed]))
            let fork = FakeDesktop.task("f0rk0000-0000-4000-8000-000000000002", project: Self.project, title: "Restock (2)", status: "pending")
            d.replies["POST /rpc/task-runs/run-1/fork"] = .json(status: 200, FakeDesktop.text(["task": fork, "mode": "native"]))
        }
        let phone = try desktop.phone()
        let w = phone.workspace
        let box = Box()
        let reader = Task { for await value in w.conversation(sessionID: Self.task) { box.set(value) } }
        defer { reader.cancel() }
        try await eventually("runs") { box.get()?.hasRun == true && box.get()?.queue.count == 1 }
        _ = try await w.currentTasks()

        let prompt = PromptContent.format(text: "Go", references: [.init(kind: .file, path: "src/stock.ts")], images: [.init(name: "a.png", path: ".chro-context/a.png")])
        try await w.send(sessionID: Self.task, prompt: prompt, runtime: RuntimeChoice(agent: .claudeCode, model: "Opus 5.5", effort: .high), imageIDs: ["img-1"])
        let sent = try #require(desktop.requests("POST", "/rpc/tasks/\(Self.task)/messages").last?.bodyObject as? [String: Any])
        #expect(sent["prompt"] as? String == prompt)
        #expect(sent["mode"] as? String == "auto")
        #expect(sent["image_ids"] as? [String] == ["img-1"])
        #expect((sent["executor_profile_id"] as? [String: Any])?["model"] as? String == "opus")
        #expect((sent["executor_profile_id"] as? [String: Any])?["reasoning_effort"] as? String == "high")
        #expect((sent["context_refs"] as? [[String: Any]])?.first?["path"] as? String == "src/stock.ts")
        #expect(sent["use_worktree"] as? Bool == true)
        #expect(sent["target_branch"] as? String == "main")

        try await w.enqueue(sessionID: Self.task, prompt: "Later")
        #expect((desktop.requests("POST", "/rpc/tasks/\(Self.task)/queue").last?.bodyObject as? [String: Any])?["prompt"] as? String == "Later")
        try await w.updateQueued(sessionID: Self.task, itemID: "q1", prompt: "Then summarize twice")
        #expect(desktop.requests("PATCH", "/rpc/tasks/\(Self.task)/queue/q1").last?.bodyObject as? [String: String] == ["prompt": "Then summarize twice"])
        try await w.moveQueued(sessionID: Self.task, itemID: "q1", to: 0)
        #expect(desktop.requests("PUT", "/rpc/tasks/\(Self.task)/queue").last?.bodyObject as? [String: [String]] == ["item_ids": ["q1"]])
        try await w.sendQueuedNow(sessionID: Self.task, itemID: "q1")
        #expect(desktop.requests("POST", "/rpc/tasks/\(Self.task)/queue/q1/send").count == 1)
        try await w.removeQueued(sessionID: Self.task, itemID: "q1")
        #expect(desktop.requests("DELETE", "/rpc/tasks/\(Self.task)/queue/q1").count == 1)

        try await w.stop(sessionID: Self.task)
        #expect(desktop.requests("POST", "/rpc/task-runs/run-2/cancel").count == 1, "Stop cancels the running run")

        try await w.respond(sessionID: Self.task, approvalID: "ap-1", response: .question(.answered([.init(question: "Which policy?", answer: "Weekly")])))
        let answered = desktop.requests("POST", "/rpc/approvals/ap-1/respond").last?.bodyObject as? [String: Any]
        #expect(answered?["answers"] as? [String: String] == ["Which policy?": "Weekly"])

        try await w.rename(sessionID: Self.task, title: " Restock policy ")
        #expect(desktop.requests("PATCH", "/rpc/tasks/\(Self.task)/title").last?.bodyObject as? [String: String] == ["title": "Restock policy"])
        try await eventually("renamed in the list") { w.sessionList.value.first { $0.id == Self.task }?.title == "Restock policy" }

        let forked = try await w.continueFromRun(sessionID: Self.task, runID: "run-1")
        #expect(forked.title == "Restock (2)")
        #expect(desktop.requests("POST", "/rpc/task-runs/run-1/fork").last?.bodyObject as? [String: String] == ["workspace": "same"])

        try await w.abortConflict(sessionID: Self.task)
        #expect(desktop.requests("POST", "/rpc/task-runs/run-2/conflicts/abort").count == 1)
        #expect(desktop.violations.isEmpty)
    }

    @Test func refusalsCarryTheDesktopsText() async throws {
        desktop.edit { $0.failures["/rpc/tasks/\(Self.task)/messages"] = (409, "A turn is already running") }
        let phone = try desktop.phone()
        try await eventually("listed") { phone.workspace.sessionList.value.count == 1 }
        do {
            try await phone.workspace.send(sessionID: Self.task, prompt: "Go", runtime: RuntimeChoice(agent: .claudeCode), imageIDs: [])
            Issue.record("expected a refusal")
        } catch {
            #expect(error as? ServiceError == .refused("A turn is already running"), "\(error) \(desktop.requests.map { "\($0.method) \($0.path)" })")
        }
    }

    @Test func imagesUploadToTheRunAndLoadThroughTheirProxy() async throws {
        desktop.edit { d in
            d.replies["POST /rpc/task-runs/run-2/images/upload"] = .json(status: 200, FakeDesktop.text(["image": [
                "id": "img-9", "file_path": ".chro-context/9.png", "original_name": "photo-1.png", "mime_type": "image/png", "size_bytes": 3,
                "hash": "h", "created_at": FakeDesktop.createdAt, "updated_at": FakeDesktop.createdAt,
            ]]))
            d.replies["GET /rpc/images/metadata"] = .json(status: 200, FakeDesktop.text(["exists": true, "id": "img-9", "proxy_url": "/rpc/images/img-9/file"]))
            d.replies["GET /rpc/images/img-9/file"] = .binary(status: 200, contentType: "image/png", Data([0x89, 0x50, 0x4E]))
        }
        let phone = try desktop.phone()
        try await eventually("listed") { phone.workspace.sessionList.value.count == 1 }
        let image = try await phone.workspace.uploadImage(sessionID: Self.task, data: Data([1, 2, 3]), fileName: "photo-1.png", contentType: "image/png")
        #expect(image == ChroServices.UploadedImage(id: "img-9", name: "photo-1.png", path: ".chro-context/9.png"))
        let upload = try #require(desktop.requests("POST", "/rpc/task-runs/run-2/images/upload").last?.upload)
        #expect(upload.field == "image")
        #expect(upload.data == Data([1, 2, 3]))
        let bytes = try await phone.workspace.image(sessionID: Self.task, path: ".chro-context/9.png")
        #expect(bytes == Data([0x89, 0x50, 0x4E]))
        #expect(desktop.requests("GET", "/rpc/images/metadata").last?.query == ["path": ".chro-context/9.png"])
    }
}
