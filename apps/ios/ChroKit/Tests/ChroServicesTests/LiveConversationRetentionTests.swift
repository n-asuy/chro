import ChroAPI
import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// What the live conversations keep in memory: completed runs outside the
/// history window are released while a session stays open, closing a session
/// resets its expanded history, and inactive sessions are evicted by an LRU
/// bounded in count and bytes.
@Suite(.timeLimit(.minutes(1)))
struct LiveConversationRetentionTests {
    static let project = LiveConversationTests.project
    let desktop = FakeDesktop()

    private static func patch(_ path: String, _ value: Any, op: String = "add") -> [String: Any] { ["op": op, "path": path, "value": value] }
    private static func patchMessage(_ ops: [[String: Any]]) -> [String: Any] { ["type": "json_patch", "payload": ops] }
    private static func logMessage(_ text: String) -> String {
        FakeDesktop.text(["JsonPatch": [patch("/entries/0", LiveConversationTests.entry("assistant_message", text))]])
    }

    private static func taskID(_ index: Int) -> String { String(format: "aaaa0000-0000-4000-8000-%012d", index) }

    private static func run(_ id: String, task: String, status: String, at index: Int) -> [String: Any] {
        ["id": id, "task_id": task, "status": status, "created_at": String(format: "2026-11-14T%02d:%02d:%02d.000Z", index / 3600, index / 60 % 60, index % 60),
         "target_branch": "main", "container_ref": "/wt/\(id)", "executor_label": NSNull()]
    }

    /// `count` sessions, each with one finished run whose log carries `padding` characters.
    private func seed(sessions count: Int, padding: Int = 10) {
        desktop.edit { d in
            d.projects = [FakeDesktop.project(Self.project, name: "inventory-service", path: "/Users/me/inventory-service")]
            for index in 0..<count {
                let task = Self.taskID(index)
                let run = "run-\(index)"
                d.tasks[task] = FakeDesktop.task(task, project: Self.project, title: "Session \(index)")
                d.streamSnapshots[FakeDesktop.streamKey("/streams/tasks/:task_id/runs", id: task)] =
                    [FakeDesktop.text(Self.patchMessage([Self.patch("/task_runs", [run: Self.run(run, task: task, status: "completed", at: index)], op: "replace")]))]
                d.streamSnapshots[FakeDesktop.streamKey("/streams/task-runs/:id/logs", id: run)] =
                    [Self.logMessage(String(repeating: "x", count: padding)), FakeDesktop.text(["finished": true])]
            }
        }
    }

    /// Reads `id`'s conversation until `condition` holds, then stops reading.
    private func read(_ workspace: LiveWorkspace, _ id: String, _ what: String, _ condition: @escaping @Sendable (SessionConversation) -> Bool) async throws {
        let done = Flag()
        let reader = Task {
            for await value in workspace.conversation(sessionID: id) where condition(value) {
                done.set()
                return
            }
        }
        try await eventually(what) { done.isSet }
        reader.cancel()
        _ = await reader.value
    }

    private final class Latest: @unchecked Sendable {
        private let lock = NSLock()
        private var value: SessionConversation?
        func set(_ value: SessionConversation) { lock.withLock { self.value = value } }
        func get() -> SessionConversation? { lock.withLock { value } }
    }

    private final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false
        func set() { lock.withLock { value = true } }
        var isSet: Bool { lock.withLock { value } }
    }

    @Test func hundredsOfTurnsKeepOnlyTheHistoryWindowsLogs() async throws {
        seed(sessions: 1)
        let task = Self.taskID(0)
        desktop.edit { d in
            for index in 1...300 {
                d.streamSnapshots[FakeDesktop.streamKey("/streams/task-runs/:id/logs", id: "run-t\(index)")] =
                    [Self.logMessage("turn \(index)"), FakeDesktop.text(["finished": true])]
            }
        }
        let phone = try desktop.phone()
        let latest = Latest()
        let reader = Task { for await value in phone.workspace.conversation(sessionID: task) { latest.set(value) } }
        defer { reader.cancel() }
        try await eventually("first log") { phone.workspace.conversations.retention[task]?.logs == 1 }
        // One turn at a time, as a session runs them.
        for index in 1...300 {
            let run = "run-t\(index)"
            try await desktop.push("/streams/tasks/:task_id/runs", id: task,
                                   Self.patchMessage([Self.patch("/task_runs/\(run)", Self.run(run, task: task, status: "completed", at: index))]))
            try await eventually("turn \(index) shown") { latest.get()?.entries.last?.kind == .assistantMessage("turn \(index)") }
        }
        #expect(latest.get()?.entries.map(\.kind) == [.assistantMessage("turn 298"), .assistantMessage("turn 299"), .assistantMessage("turn 300")])
        let window = ConversationWire.historyPage
        try await eventually("pruned to the window") {
            guard let retained = phone.workspace.conversations.retention[task] else { return false }
            return retained.logs <= window && retained.runFeeds <= window
        }
        // Only the window's log subscriptions stay open on the desktop.
        try await eventually("old log subscriptions released") {
            desktop.responders.flatMap(\.subscriptions).filter { $0.stream == "/streams/task-runs/:id/logs" }.count <= window
        }
        #expect(desktop.violations.isEmpty)
    }

    @Test func closingResetsTheExpandedHistory() async throws {
        seed(sessions: 1)
        let task = Self.taskID(0)
        desktop.edit { d in
            var runs: [String: Any] = [:]
            for index in 0..<9 { runs["r\(index)"] = Self.run("r\(index)", task: task, status: "completed", at: index) }
            d.streamSnapshots[FakeDesktop.streamKey("/streams/tasks/:task_id/runs", id: task)] =
                [FakeDesktop.text(Self.patchMessage([Self.patch("/task_runs", runs, op: "replace")]))]
            for index in 0..<9 {
                d.streamSnapshots[FakeDesktop.streamKey("/streams/task-runs/:id/logs", id: "r\(index)")] = [Self.logMessage("turn \(index)"), FakeDesktop.text(["finished": true])]
            }
        }
        let phone = try desktop.phone()
        let workspace = phone.workspace
        let expanded = Task {
            for await value in workspace.conversation(sessionID: task) where value.entries.count == 3 {
                await workspace.loadEarlierHistory(sessionID: task)
                await workspace.loadEarlierHistory(sessionID: task)
                break
            }
        }
        _ = await expanded.value
        try await eventually("closed with nine logs released") {
            guard let retained = workspace.conversations.retention[task] else { return false }
            return !retained.isOpen && retained.logs <= ConversationWire.historyPage && retained.runFeeds == 0
        }
        try await read(workspace, task, "reopened on the first page") { $0.isLoaded && $0.entries.count == 3 && $0.hasEarlierHistory }
    }

    @Test func visitingManySessionsKeepsABoundedNumberOfInactiveFeeds() async throws {
        let count = LiveConversations.maxInactiveFeeds * 3
        seed(sessions: count)
        let phone = try desktop.phone()
        for index in 0..<count {
            try await read(phone.workspace, Self.taskID(index), "session \(index)") { $0.entries.count == 1 }
        }
        try await eventually("bounded") { phone.workspace.conversations.retention.count <= LiveConversations.maxInactiveFeeds }
        let retained = phone.workspace.conversations.retention
        // The most recently visited stay; the oldest went first.
        #expect(retained[Self.taskID(count - 1)] != nil)
        #expect(retained[Self.taskID(0)] == nil)
        #expect(retained.values.allSatisfy { !$0.isOpen && $0.runFeeds == 0 })
    }

    @Test func inactiveFeedsAreEvictedByBytes() async throws {
        // Each session's log is a quarter of the byte budget: at most four fit.
        let quarter = LiveConversations.inactiveByteBudget / 4
        seed(sessions: 8, padding: quarter)
        let phone = try desktop.phone()
        for index in 0..<8 {
            try await read(phone.workspace, Self.taskID(index), "session \(index)") { $0.entries.count == 1 }
        }
        try await eventually("bounded by bytes") {
            let retained = phone.workspace.conversations.retention
            return retained.count < 4 && retained.values.reduce(0) { $0 + $1.bytes } <= LiveConversations.inactiveByteBudget
        }
        #expect(phone.workspace.conversations.retention[Self.taskID(7)] != nil)
    }

    @Test func anOpenSessionIsNeverEvicted() async throws {
        let count = LiveConversations.maxInactiveFeeds + 4
        seed(sessions: count)
        let phone = try desktop.phone()
        let first = Self.taskID(0)
        let holder = Task { for await _ in phone.workspace.conversation(sessionID: first) {} }
        defer { holder.cancel() }
        for index in 1..<count {
            try await read(phone.workspace, Self.taskID(index), "session \(index)") { $0.entries.count == 1 }
        }
        try await eventually("evicted down to the bound") { phone.workspace.conversations.retention.count <= LiveConversations.maxInactiveFeeds + 1 }
        #expect(phone.workspace.conversations.retention[first]?.isOpen == true)
    }
}
