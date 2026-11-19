import ChroDomain
import XCTest

/// conversation-view.tsx (Group per user turn) and utils/agent-step-segments.ts.
final class ConversationLayoutTests: XCTestCase {
    private var counter = 0

    private func entry(_ kind: ConversationEntryKind, run: String = "r1", inherited: Bool = false) -> ConversationEntry {
        counter += 1
        return ConversationEntry(id: "\(run):\(counter)", runID: run, kind: kind, isInherited: inherited)
    }

    private func bash(_ command: String, status: ToolStatus = .success) -> ConversationEntryKind {
        .toolUse(ToolUse(toolName: "Bash", action: .commandRun(command: command, result: nil), status: status))
    }

    func testEachUserMessageOpensATurnAndLeadingEntriesFormTheirOwn() {
        let system = entry(.systemMessage("Setup"))
        let first = entry(.userMessage("one"))
        let reply = entry(.assistantMessage("ok"))
        let second = entry(.userMessage("two"))
        let turns = ConversationLayout.turns([system, first, reply, second])
        XCTAssertEqual(turns.count, 3)
        XCTAssertNil(turns[0].prompt)
        XCTAssertEqual(turns[1].prompt?.id, first.id)
        XCTAssertEqual(turns[1].segments, [.entry(reply)])
        XCTAssertEqual(turns[2].segments, [])
        XCTAssertEqual(turns.map(\.id), [system.id, first.id, second.id])
    }

    func testConsecutiveWorkingEntriesCollapseIntoOneStepsRun() {
        let thinking = entry(.thinking("**Checking** the `stock` module"))
        let empty = entry(.thinking("   "))
        let read = entry(.toolUse(ToolUse(toolName: "Read", action: .fileRead(path: "src/stock.ts"), status: .success)))
        let reply = entry(.assistantMessage("Done."))
        let run = entry(bash("ls\npwd"))
        let segments = ConversationLayout.segments([thinking, empty, read, reply, run])
        XCTAssertEqual(segments.count, 3)
        guard case .steps(let first) = segments[0], case .steps(let last) = segments[2] else { return XCTFail("steps expected") }
        XCTAssertEqual(first.entries.map(\.id), [thinking.id, read.id], "empty thinking is dropped")
        XCTAssertEqual(first.label, "Checking the stock module")
        XCTAssertFalse(first.isLive)
        // A tool-only run inherits the turn's latest reasoning prose.
        XCTAssertEqual(last.label, "Checking the stock module")
        XCTAssertEqual(first.id, "steps:\(thinking.id)")
    }

    func testStepsLabelFallsBackToTheLatestToolSummary() {
        let edit = entry(.toolUse(ToolUse(toolName: "Edit", action: .fileEdit(path: "src/a.ts", changes: []), status: .success)))
        let command = entry(bash("\n  npm test\n  echo done"))
        guard case .steps(let steps) = ConversationLayout.segments([edit, command])[0] else { return XCTFail() }
        XCTAssertEqual(steps.label, "$ npm test")
    }

    func testLoadingOnlyRunIsLiveAndDoesNotInheritProse() {
        let thinking = entry(.thinking("Planning"))
        let reply = entry(.assistantMessage("Here goes"))
        let loading = entry(.loading(""))
        let segments = ConversationLayout.segments([thinking, reply, loading])
        guard case .steps(let trailing) = segments[2] else { return XCTFail() }
        XCTAssertTrue(trailing.isLive)
        XCTAssertNil(trailing.label)
        XCTAssertEqual(trailing.headerText, "Thinking", "the desktop's static label, live or not (thinkingLabel)")
    }

    /// conversation-view.tsx AgentThinkingSteps: `segment.label ?? t("thinkingLabel")`.
    func testTheHeaderIsTheLabelElseThinking() {
        let read = entry(.toolUse(ToolUse(toolName: "Read", action: .fileRead(path: "src/stock.ts"), status: .success)))
        let loading = entry(.loading(""))
        guard case .steps(let live) = ConversationLayout.segments([read, loading])[0] else { return XCTFail() }
        XCTAssertTrue(live.isLive)
        XCTAssertEqual(live.headerText, "src/stock.ts")
        guard case .steps(let empty) = ConversationLayout.segments([entry(.loading(""))])[0] else { return XCTFail() }
        XCTAssertEqual(empty.headerText, "Thinking")
    }

    /// The loading step's shimmer: its content, else `processingPlaceholder`.
    func testTheLoadingStepShowsItsContentElseInProgress() {
        XCTAssertEqual(ConversationLayout.loadingStepText(""), "In Progress...")
        XCTAssertEqual(ConversationLayout.loadingStepText("Compacting\nconversation"), "Compacting\nconversation")
    }

    /// text-shimmer.tsx animates a 250%-wide background from position 100% to 0%,
    /// so the highlight enters past the left edge and leaves past the right one.
    func testTheShimmerHighlightSweepsLeftToRight() {
        let width = 100.0
        let center = { (phase: Double) in ConversationLayout.shimmerHighlightCenter(width: width, phase: phase) }
        XCTAssertEqual(center(0), -25, accuracy: 1e-9)
        XCTAssertEqual(center(0.5), 50, accuracy: 1e-9)
        XCTAssertEqual(center(1), 125, accuracy: 1e-9)
    }

    func testPendingApprovalMakesTheRunLiveAndForcesItOpen() {
        let call = entry(.toolUse(ToolUse(toolName: "mcp__github__create_pull_request", action: .tool(name: "mcp:github:create_pull_request", arguments: nil, result: nil),
                                          status: .pendingApproval(approvalID: "a1", timeoutAt: nil))))
        guard case .steps(let steps) = ConversationLayout.segments([call])[0] else { return XCTFail() }
        XCTAssertTrue(steps.isLive)
        XCTAssertTrue(steps.awaitingApproval)
        XCTAssertEqual(steps.label, "mcp__github__create_pull_request")
    }

    /// The card under the conversation answers a pending MCP approval; its raw
    /// `codex.mcp_tool_call` entry would repeat it in the timeline (mock slot 6).
    func testTheMcpApprovalOnTheCardLeavesTheTimelineButKeepsTheRunLive() {
        let prompt = entry(.userMessage("run it"))
        let command = entry(bash("/bin/zsh -lc 'for i in $(seq 1 90); do echo $i; done'"))
        let pending = entry(.toolUse(ToolUse(toolName: McpApprovalPrompt.toolName, action: .tool(name: McpApprovalPrompt.toolName, arguments: nil, result: nil),
                                             status: .pendingApproval(approvalID: "a1", timeoutAt: nil), content: "codex.mcp_tool_call (approval pending)")))
        let onCard = ConversationLayout.turns([prompt, command, pending], approvalOnCard: "a1")
        guard case .steps(let steps) = onCard[0].segments[0] else { return XCTFail("steps expected") }
        XCTAssertEqual(steps.entries.map(\.id), [command.id])
        XCTAssertEqual(steps.label, "$ /bin/zsh -lc 'for i in $(seq 1 90); do echo $i; done'")
        XCTAssertTrue(steps.isLive)
        XCTAssertTrue(steps.awaitingApproval)

        // Another approval on the card, or none, leaves the entry where it is.
        for card in [nil, "other"] as [String?] {
            guard case .steps(let all) = ConversationLayout.turns([prompt, command, pending], approvalOnCard: card)[0].segments[0] else { return XCTFail() }
            XCTAssertEqual(all.entries.map(\.id), [command.id, pending.id])
        }
    }

    func testStepSummaryPerAction() {
        func summary(_ action: ToolAction, name: String = "T") -> String? {
            ConversationLayout.stepSummary(.toolUse(ToolUse(toolName: name, action: action, status: .success)))
        }
        XCTAssertEqual(summary(.commandRun(command: "", result: nil), name: "Bash"), "Bash")
        XCTAssertEqual(summary(.search(query: "removeStock")), "removeStock")
        XCTAssertEqual(summary(.webFetch(url: "https://example.com")), "https://example.com")
        XCTAssertEqual(summary(.taskCreate(description: "x"), name: "Task"), "Task")
        XCTAssertNil(ConversationLayout.stepSummary(.thinking("# ")))
        XCTAssertEqual(ConversationLayout.stepSummary(.loading("Compacting conversation")), "Compacting conversation")
    }

    func testFinalAssistantMessageCarriesTheTurnsActions() {
        let prompt = entry(.userMessage("go"))
        let early = entry(.assistantMessage("first"))
        let tool = entry(bash("ls"))
        let late = entry(.assistantMessage("second"), run: "r2")
        let turn = ConversationLayout.turns([prompt, early, tool, late])[0]
        XCTAssertEqual(turn.lastAssistantEntryID, late.id)
        XCTAssertEqual(turn.anchorRunID, "r2")
    }

    func testInheritedTurnsAreMarkedAndNeverCarryActions() {
        let prompt = entry(.userMessage("go"), inherited: true)
        let reply = entry(.assistantMessage("ok"), inherited: true)
        let turn = ConversationLayout.turns([prompt, reply])[0]
        XCTAssertTrue(turn.isInherited)
        XCTAssertNil(turn.lastAssistantEntryID)
    }

    func testMessageActionsWaitForTheTurnToFinish() {
        XCTAssertTrue(ConversationLayout.showsMessageActions(turnIndex: 0, turnCount: 2, isRunning: true))
        XCTAssertFalse(ConversationLayout.showsMessageActions(turnIndex: 1, turnCount: 2, isRunning: true))
        XCTAssertTrue(ConversationLayout.showsMessageActions(turnIndex: 1, turnCount: 2, isRunning: false))
    }

    func testRunWithLine() {
        XCTAssertEqual(RunWithLine.parse("Run with Opus 5.5"), RunWithLine(model: "Opus 5.5", effort: nil))
        XCTAssertEqual(RunWithLine.parse("Run with GPT-6.1 Sol reasoning effort: Extra High"), RunWithLine(model: "GPT-6.1 Sol", effort: "Extra High"))
        XCTAssertNil(RunWithLine.parse("Setup complete"))
        XCTAssertEqual(RunWithLine(model: "Haiku 5.5", effort: "High").content, "Run with Haiku 5.5 reasoning effort: High")
    }

    func testMessageNavListsUserPromptsByFirstTextLine() {
        let first = entry(.userMessage("<context>\n<file path=\"src/a.ts\" />\n</context>\n\n  Fix the bug\nthen test"))
        let reply = entry(.assistantMessage("ok"))
        let second = entry(.userMessage("<skills_context>\n<skill id=\"s\" name=\"chro\" />\n</skills_context>"))
        let items = ConversationLayout.navItems([first, reply, second])
        XCTAssertEqual(items.map(\.entryID), [first.id, second.id])
        XCTAssertEqual(items[0].label, "Fix the bug")
        XCTAssertEqual(items[1].label, second.kind.userContent?.trimmingCharacters(in: .whitespacesAndNewlines), "falls back to the raw prompt")
    }
}
