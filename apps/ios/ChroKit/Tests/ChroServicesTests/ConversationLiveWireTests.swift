import ChroAPI
import ChroDomain
import Foundation
import Testing
@testable import ChroServices

private func json(_ text: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) }

/// The desktop's conversation wire (crates/log-types normalized.rs, use-conversation-history.ts,
/// session-relations.ts, mcp-approval-mapping.ts) as the live service reads and writes it.
struct ConversationLiveWireTests {
    @Test func normalizedEntriesDecode() throws {
        let command = json("""
        {"type":"NORMALIZED_ENTRY","content":{"timestamp":"2026-11-14T09:00:00.000Z","type":{"type":"tool_use","tool_name":"Bash",
         "action_type":{"action":"command_run","command":"ls","result":{"exit_status":{"type":"exit_code","code":2},"output":"x"}},
         "status":{"status":"failed"}},"content":"ls","metadata":null}}
        """)
        let entry = try #require(ConversationWire.entry(command, runID: "r1", index: 3))
        #expect(entry.id == "r1:stream-entry:3")
        #expect(entry.timestamp != nil)
        #expect(entry.kind == .toolUse(ToolUse(toolName: "Bash", action: .commandRun(command: "ls", result: CommandResult(exitStatus: .exitCode(2), output: "x")),
                                               status: .failed, content: "ls")))

        let pending = json("""
        {"type":{"type":"tool_use","tool_name":"AskUserQuestion","action_type":{"action":"tool","tool_name":"AskUserQuestion","arguments":{"questions":[]},"result":null},
         "status":{"status":"pending_approval","approval_id":"a1","requested_at":"2026-11-14T09:00:00Z","timeout_at":"2026-11-14T10:00:00Z"}},"content":""}
        """)
        guard case .toolUse(let tool)? = ConversationWire.entry(pending, runID: "r", index: 0)?.kind,
              case .pendingApproval(let id, let timeout) = tool.status, case .tool(_, let arguments, let result) = tool.action else {
            Issue.record("pending tool"); return
        }
        #expect(id == "a1")
        #expect(timeout != nil)
        #expect(arguments == .object(["questions": .array([])]))
        #expect(result == nil)

        let edit = json("""
        {"type":{"type":"tool_use","tool_name":"Edit","action_type":{"action":"file_edit","path":"a.ts","changes":[
         {"action":"edit","unified_diff":"@@","has_line_numbers":true},{"action":"write","content":"x"},{"action":"delete"},{"action":"rename","new_path":"b.ts"}]},
         "status":{"status":"denied","reason":"no"}},"content":"a.ts"}
        """)
        #expect(ConversationWire.entry(edit, runID: "r", index: 0)?.kind == .toolUse(ToolUse(
            toolName: "Edit", action: .fileEdit(path: "a.ts", changes: [.edit(unifiedDiff: "@@"), .write(content: "x"), .delete, .rename(newPath: "b.ts")]),
            status: .denied(reason: "no"), content: "a.ts")))

        let mcpResult = json("""
        {"type":{"type":"tool_use","tool_name":"mcp__gh__x","action_type":{"action":"tool","tool_name":"mcp:gh:x","arguments":null,"result":{"type":"json","value":{"ok":true}}},
         "status":{"status":"success"}},"content":"mcp:gh:x"}
        """)
        guard case .toolUse(let mcp)? = ConversationWire.entry(mcpResult, runID: "r", index: 0)?.kind, case .tool(let name, nil, let value) = mcp.action else {
            Issue.record("mcp tool"); return
        }
        #expect(name == "mcp:gh:x")
        #expect(value == .object(["ok": .bool(true)]), "the result's value, as the desktop reads it")

        #expect(ConversationWire.entry(json(#"{"type":{"type":"error_message","error_type":{"type":"api_error"}},"content":"limit"}"#), runID: "r", index: 0)?.kind
            == .errorMessage("limit", .apiError))
        #expect(ConversationWire.entry(json(#"{"type":{"type":"user_feedback","denied_tool":"Bash"},"content":"no"}"#), runID: "r", index: 0)?.kind == .systemMessage("no"))
        #expect(ConversationWire.entry(json(#"{"type":{"type":"assistant_message"},"content":"hi"}"#), runID: "r", index: 0)?.kind == .assistantMessage("hi"))
        #expect(ConversationWire.entry(json(#"{"type":{"type":"mystery"},"content":"?"}"#), runID: "r", index: 0) == nil)
    }

    @Test func logPatchesBuildEntriesAndApprovals() {
        var log = ConversationWire.RunLog()
        log.apply([json(#"{"op":"add","path":"/entries/0","value":{"a":1}}"#), json(#"{"op":"add","path":"/entries/1","value":{"a":2}}"#),
                   json(#"{"op":"replace","path":"/entries/1","value":{"a":3}}"#), json(#"{"op":"add","path":"/approvals/ap~1x","value":{"id":"ap/x"}}"#)])
        #expect(log.entries == [0: json(#"{"a":1}"#), 1: json(#"{"a":3}"#)])
        #expect(log.approvals.keys.sorted() == ["ap/x"])
        log.apply([json(#"{"op":"remove","path":"/approvals/ap~1x"}"#), json(#"{"op":"remove","path":"/entries/0"}"#)])
        #expect(log.approvals.isEmpty)
        #expect(log.entries.keys.sorted() == [1])
        log.apply([json(#"{"op":"replace","path":"/entries","value":[{"b":1}]}"#)])
        #expect(log.entries == [0: json(#"{"b":1}"#)])
    }

    @Test func logMessages() {
        #expect(ConversationWire.LogMessage(Data(#"{"replayStarted":true}"#.utf8)) == .replayStarted)
        #expect(ConversationWire.LogMessage(Data(#"{"finished":true}"#.utf8)) == .finished)
        #expect(ConversationWire.LogMessage(Data(#"{"JsonPatch":[]}"#.utf8)) == .patch([]))
        #expect(ConversationWire.LogMessage(Data(#"{"error":"gone"}"#.utf8)) == .failure("gone"))
        #expect(ConversationWire.LogMessage(Data("[]".utf8)) == .ignored)
    }

    @Test func aRunsPromptComesFromItsTaskSession() {
        var log = ConversationWire.RunLog()
        log.entries = [0: json(#"{"type":{"type":"user_message"},"content":"raw prompt"}"#), 1: json(#"{"type":{"type":"assistant_message"},"content":"ok"}"#)]
        let prompt = ConversationWire.TaskSession(json(#"{"id":"s1","task_run_id":"r1","prompt":"Fix it"}"#))
        let withPrompt = ConversationWire.entries(run: "r1", log: log, prompt: prompt)
        #expect(withPrompt.map(\.id) == ["r1:synthetic-user-s1", "r1:stream-entry:1"])
        #expect(withPrompt[0].kind == .userMessage("Fix it"))
        #expect(ConversationWire.entries(run: "r1", log: log, prompt: nil).map(\.kind) == [.userMessage("raw prompt"), .assistantMessage("ok")])
    }

    /// use-conversation-history.ts: the stream follows the first running run and stays
    /// live until its log's `finished`, even after the run turns terminal.
    @Test func theLiveRunIsTheRunningOneUntilItsLogFinishes() {
        func run(_ id: String, _ status: String) -> ConversationWire.Run { .init(id: id, status: status, createdAt: .distantPast) }
        var finished = ConversationWire.RunLog()
        finished.finished = true
        let open = ConversationWire.RunLog()

        #expect(ConversationWire.liveRun(runs: [run("a", "completed"), run("b", "running")], logs: [:], current: nil) == "b", "live before its log is read")
        #expect(ConversationWire.liveRun(runs: [run("a", "completed"), run("b", "pending")], logs: [:], current: nil) == nil, "pending is not streamed")
        #expect(ConversationWire.liveRun(runs: [run("b", "completed")], logs: ["b": open], current: "b") == "b", "terminal status, log still open")
        #expect(ConversationWire.liveRun(runs: [run("b", "completed")], logs: ["b": finished], current: "b") == nil)
        #expect(ConversationWire.liveRun(runs: [run("b", "running")], logs: ["b": finished], current: nil) == nil, "a finished log stays finished")
        #expect(ConversationWire.liveRun(runs: [run("b", "completed"), run("c", "running")], logs: ["b": open], current: "b") == "c", "a new running run takes over")
        #expect(ConversationWire.liveRun(runs: [], logs: ["b": open], current: "b") == nil, "the run left the session")
    }

    @Test func theLiveRunTrailsTheWorkingSentinel() {
        var log = ConversationWire.RunLog()
        log.entries = [0: json(#"{"type":{"type":"assistant_message"},"content":"ok"}"#)]
        #expect(ConversationWire.entries(run: "r1", log: log, prompt: nil, isLive: true).map(\.kind) == [.assistantMessage("ok"), .loading("")])
        #expect(ConversationWire.entries(run: "r1", log: log, prompt: nil, isLive: true).last?.id == "r1:loading")
        #expect(ConversationWire.entries(run: "r1", log: nil, prompt: nil, isLive: true).map(\.kind) == [.loading("")], "before the log answers")
        #expect(ConversationWire.entries(run: "r1", log: log, prompt: nil, isLive: false).map(\.kind) == [.assistantMessage("ok")])
    }

    @Test func pendingApprovalsOfTheRun() {
        var log = ConversationWire.RunLog()
        log.approvals = [
            "old": json(#"{"id":"old","task_run_id":"r1","tool_name":"AskUserQuestion","status":{"status":"approved"},"tool_input":{"questions":[{"question":"Q","header":"H","options":[],"multiSelect":false}]}}"#),
            "q": json(#"{"id":"q","task_run_id":"r1","tool_name":"AskUserQuestion","status":{"status":"pending"},"tool_input":{"questions":[{"question":"Which?","header":"Policy","options":[{"label":"A","description":"a"}],"multiSelect":false}]}}"#),
        ]
        #expect(ConversationWire.pendingApproval(log, runID: "r1")
            == .question(approvalID: "q", questions: [.init(question: "Which?", header: "Policy", options: [.init(label: "A", description: "a")], multiSelect: false)]))
        #expect(ConversationWire.pendingApproval(log, runID: "other") == nil, "another run's approval")
        log.approvals = ["m": json(#"{"id":"m","task_run_id":"r1","tool_name":"codex.mcp_tool_call","status":{"status":"pending"},"tool_input":{"server":"github","message":"Allow?","options":["allow","deny"]}}"#)]
        guard case .mcp(let id, let prompt)? = ConversationWire.pendingApproval(log, runID: "r1") else { Issue.record("mcp"); return }
        #expect(id == "m")
        #expect(prompt.options == [.allow, .deny])
    }

    @Test func respondBodies() {
        #expect(ConversationWire.respondBody(.question(.answered([.init(question: "Q", answer: "A, B")])))
            == json(#"{"status":{"status":"approved"},"answers":{"Q":"A, B"}}"#))
        #expect(ConversationWire.respondBody(.question(.skipped))
            == json(#"{"status":{"status":"denied","reason":"User skipped questions - proceed with defaults"}}"#))
        #expect(ConversationWire.respondBody(.mcp(.allowSession)) == json(#"{"status":{"status":"approved"},"answers":{"decision":"allow_session"}}"#))
        #expect(ConversationWire.respondBody(.mcp(.deny)) == json(#"{"status":{"status":"denied"},"answers":{"decision":"deny"}}"#))
    }

    @Test func runtimeFromTheRunsExecutorLabel() {
        let label = #"{"executor":"CLAUDE_CODE","variant":null,"model":"haiku","reasoning_effort":"high"}"#
        #expect(ConversationWire.runtime(label, models: LiveWorkspace.staticModels) == RuntimeChoice(agent: .claudeCode, model: "Haiku 5.5", effort: .high))
        #expect(ConversationWire.runtime(#"{"executor":"PI","model":"kimi"}"#, models: []) == RuntimeChoice(agent: .pi, model: "kimi"))
        #expect(ConversationWire.runtime("not json", models: []) == nil)
        #expect(ConversationWire.runtime(nil, models: []) == nil)
    }

    @Test func referencesKeepOneRowPerCounterpartWithItsStrongestRelation() {
        let outgoing = [
            json(#"{"task_id":"me","kind":"fork","target_task_id":"src"}"#), json(#"{"task_id":"me","kind":"session","target_task_id":"src"}"#),
            json(#"{"task_id":"me","kind":"session","target_task_id":"other"}"#), json(#"{"task_id":"me","kind":"directory","path":"docs"}"#),
            json(#"{"task_id":"me","kind":"delegate","target_task_id":"boss"}"#),
        ].compactMap(ConversationWire.ContextRef.init)
        let incoming = [
            json(#"{"task_id":"kid","kind":"delegate","target_task_id":"me"}"#), json(#"{"task_id":"next","kind":"fork","target_task_id":"me"}"#),
            json(#"{"task_id":"reader","kind":"session","target_task_id":"me"}"#),
        ].compactMap(ConversationWire.ContextRef.init)
        #expect(ConversationWire.references(outgoing: outgoing, incoming: incoming, sessionID: "me") == [
            .init(target: .session(id: "src"), relation: .continuedFrom),
            .init(target: .session(id: "other"), relation: .uses),
            .init(target: .session(id: "boss"), relation: .delegatedFrom),
            .init(target: .session(id: "kid"), relation: .delegatedTo),
            .init(target: .session(id: "next"), relation: .continuedIn),
            .init(target: .session(id: "reader"), relation: .referencedBy),
            .init(target: .path("docs", isDirectory: true), relation: .uses),
        ])
        #expect(outgoing[0].anchorRunID == nil)
        #expect(ConversationWire.ContextRef(json(#"{"task_id":"t","kind":"fork","metadata_json":"{\"run_id\":\"r9\"}"}"#))?.anchorRunID == "r9")
    }

    @Test func branchStatusAndDiffTotals() {
        var files: [String: (Int, Int)] = [:]
        ConversationWire.applyDiff([
            json(#"{"op":"replace","path":"/diffs","value":{}}"#),
            json(#"{"op":"add","path":"/diffs/src~1a.ts","value":{"type":"DIFF","content":{"additions":7,"deletions":1}}}"#),
            json(#"{"op":"add","path":"/diffs/README.md","value":{"type":"DIFF","content":{"additions":1,"deletions":0}}}"#),
        ], to: &files)
        ConversationWire.applyDiff([json(#"{"op":"remove","path":"/diffs/README.md"}"#)], to: &files)
        #expect(files.keys.sorted() == ["src/a.ts"])
        let status = ConversationWire.branchStatus(
            json(#"{"commits_ahead":1,"commits_behind":2,"target_branch":"main","is_rebase_in_progress":true,"conflicted_files":["README.md"],"conflict_op":"rebase","merges":[]}"#),
            runTarget: "dev", diff: (7, 1))
        #expect(status == SessionBranchStatus(additions: 7, deletions: 1, commitsBehind: 2, targetBranch: "main", conflict: .init(operation: .rebase, files: ["README.md"])))
        #expect(ConversationWire.branchStatus(json(#"{"commits_behind":0,"conflicted_files":[]}"#), runTarget: "dev", diff: (0, 0))
            == SessionBranchStatus(targetBranch: "dev"))
    }

    @Test func queueOrderAndRunOrder() {
        let queue = json(#"{"session_queue":{"b":{"id":"b","prompt":"second","seq":2,"created_at":"x"},"a":{"id":"a","prompt":"first","seq":1,"created_at":"y"}}}"#)
        #expect(ConversationWire.queue(queue).map(\.prompt) == ["first", "second"])
        let runs = json(#"{"task_runs":{"r2":{"id":"r2","status":"running","created_at":"2026-11-14T10:00:00Z"},"r1":{"id":"r1","status":"completed","created_at":"2026-11-14T09:00:00.000Z","target_branch":"main","container_ref":"/wt"}}}"#)
        let rows = ConversationWire.runs(runs)
        #expect(rows.map(\.id) == ["r1", "r2"])
        #expect(rows[1].isActive)
        #expect(rows[0].containerRef == "/wt")
    }
}
