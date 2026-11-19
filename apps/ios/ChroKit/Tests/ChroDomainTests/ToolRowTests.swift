import ChroAPI
import ChroDomain
import XCTest

/// ToolCallEntryContent and toolIcon (conversation-view.tsx).
final class ToolRowTests: XCTestCase {
    private func row(_ action: ToolAction, name: String = "Bash", status: ToolStatus = .success, content: String = "") -> ToolRow {
        ToolRow(ToolUse(toolName: name, action: action, status: status, content: content))
    }

    func testCommandRowSummaryIconAndDetail() {
        let tool = row(.commandRun(command: "`git diff --stat && git diff`", result: CommandResult(exitStatus: .exitCode(0), output: " 1 file changed")))
        XCTAssertEqual(tool.icon, .terminal)
        XCTAssertEqual(tool.label, "Bash")
        XCTAssertEqual(tool.summary, "$ `git diff --stat && git diff`")
        XCTAssertTrue(tool.canExpand)
        XCTAssertFalse(tool.startsExpanded)
        XCTAssertEqual(tool.detail, .command([
            .init(title: "Command", body: .code("`git diff --stat && git diff`")),
            .init(title: "Output", body: .code(" 1 file changed")),
            .init(title: "Status", body: .note("Exit Code 0")),
        ]))
    }

    func testMultiLineCommandSummaryAndEmptyOutput() {
        let tool = row(.commandRun(command: "\nls\npwd", result: CommandResult(exitStatus: .success(false), output: "  ")))
        XCTAssertEqual(tool.summary, "$ ls …")
        XCTAssertEqual(tool.detail, .command([
            .init(title: "Command", body: .code("ls\npwd")),
            .init(title: "Output", body: .note("No output produced.")),
            .init(title: "Status", body: .note("Failed")),
        ]))
    }

    func testFailedDeniedOrTimedOutCommandsStartExpanded() {
        for status in [ToolStatus.failed, .denied(reason: nil), .timedOut] {
            XCTAssertTrue(row(.commandRun(command: "make", result: nil), status: status).startsExpanded)
        }
        XCTAssertFalse(row(.search(query: "x"), name: "Grep", status: .failed).startsExpanded, "only commands")
    }

    func testRunningCommandWithoutResultStillExpandsToItsCommand() {
        let tool = row(.commandRun(command: "sleep 600", result: nil))
        XCTAssertTrue(tool.canExpand)
        XCTAssertEqual(tool.detail, .command([.init(title: "Command", body: .code("sleep 600"))]))
    }

    func testFileRowsLinkTheirPath() {
        let read = row(.fileRead(path: "src/stock.ts"), name: "Read")
        XCTAssertEqual(read.icon, .eye)
        XCTAssertEqual(read.summary, "src/stock.ts")
        XCTAssertEqual(read.linkedPath, "src/stock.ts")
        XCTAssertFalse(read.canExpand)

        let edit = row(.fileEdit(path: "src/stock.test.ts", changes: [.edit(unifiedDiff: "@@ -1 +1 @@\n-a\n+b")]), name: "Edit")
        XCTAssertEqual(edit.icon, .squarePen)
        XCTAssertTrue(edit.canExpand)
        XCTAssertEqual(edit.detail, .fileChanges(path: "src/stock.test.ts", changes: [.edit(unifiedDiff: "@@ -1 +1 @@\n-a\n+b")]))
        XCTAssertFalse(row(.fileEdit(path: "a", changes: []), name: "Write").canExpand)
    }

    func testOtherActionsUseTheSingleLineContentAsSummary() {
        let grep = row(.search(query: "removeStock"), name: "Grep", content: "`removeStock`")
        XCTAssertEqual(grep.icon, .search)
        XCTAssertEqual(grep.summary, "`removeStock`")
        XCTAssertFalse(grep.canExpand)
        XCTAssertNil(row(.search(query: "x"), name: "Grep", content: "a\nb").summary, "multi-line content shows no inline summary")
        XCTAssertNil(row(.other(description: ""), name: "LS", content: "{").summary)
        XCTAssertEqual(row(.webFetch(url: "u"), name: "WebFetch").icon, .globe)
        XCTAssertEqual(row(.taskCreate(description: "x"), name: "Task").icon, .hammer)
        XCTAssertEqual(row(.planPresentation(plan: "p"), name: "ExitPlanMode").icon, .squareCheck)
        XCTAssertEqual(row(.commandRun(command: "", result: nil), name: "").label, "Command")
    }

    /// The executor's content for an approval entry is the tool name, plus
    /// " (approval pending)" while it waits (codex/normalize_logs.rs): the label already says it.
    func testContentThatOnlyRepeatsTheLabelIsNoSummary() {
        let action = ToolAction.tool(name: McpApprovalPrompt.toolName, arguments: nil, result: nil)
        XCTAssertNil(row(action, name: McpApprovalPrompt.toolName, status: .pendingApproval(approvalID: "a", timeoutAt: nil), content: "codex.mcp_tool_call (approval pending)").summary)
        XCTAssertNil(row(action, name: McpApprovalPrompt.toolName, content: "codex.mcp_tool_call").summary)
        XCTAssertEqual(row(.search(query: "x"), name: "Grep", content: "Grep stock").summary, "Grep stock")
    }

    func testToolCallsShowArgumentsAndResult() {
        let tool = row(.tool(name: "mcp:github:create_issue", arguments: .object(["title": .string("Bug")]), result: nil), name: "mcp__github__create_issue")
        XCTAssertEqual(tool.icon, .hammer)
        XCTAssertTrue(tool.canExpand)
        XCTAssertEqual(tool.detail, .structured(arguments: .object(["title": .string("Bug")]), result: nil))
        XCTAssertFalse(row(.tool(name: "x", arguments: nil, result: nil), name: "x").canExpand)
    }

    func testTodosAlwaysExpand() {
        let tool = row(.todoManagement(todos: [TodoItem(content: "Write tests", status: "done")], operation: "write"), name: "TodoWrite", content: "TODO list updated")
        XCTAssertTrue(tool.canExpand)
        XCTAssertEqual(tool.icon, .squareCheck)
        XCTAssertEqual(tool.detail, .todos([TodoItem(content: "Write tests", status: "done")]))
    }

    func testStatusNotes() {
        let pending = row(.tool(name: "x", arguments: nil, result: nil), name: "x",
                          status: .pendingApproval(approvalID: "a", timeoutAt: Date(timeIntervalSince1970: 0)))
        XCTAssertEqual(pending.statusNote, .pending("Pending approval (timeout: 1970-01-01T00:00:00Z)"))
        XCTAssertEqual(row(.commandRun(command: "rm", result: nil), status: .denied(reason: "Not now")).statusNote, .denied("Denial Reason: Not now"))
        XCTAssertNil(row(.commandRun(command: "rm", result: nil), status: .denied(reason: nil)).statusNote)
        XCTAssertNil(row(.commandRun(command: "rm", result: nil), status: .failed).statusNote, "a failed tool is never styled as an error")
    }

    func testAskUserQuestionIsNotAToolRow() {
        XCTAssertTrue(row(.tool(name: "AskUserQuestion", arguments: nil, result: nil), name: "AskUserQuestion").isQuestion)
        XCTAssertFalse(row(.commandRun(command: "ls", result: nil)).isQuestion)
    }
}
