import ChroAPI
import ChroDomain
import Foundation

/// The conversations of the HTML mock's captured sessions (`SESSIONS`,
/// `SESSIONS2`, `IMG_TURN1/2`, `RW_ENTRIES` in `.claude/mocks/mobile-companion`),
/// as normalized log entries.
///
/// Completed hand-made by the fixture, because the capture shows only what the
/// screen drew:
/// - the run and entry ids, and the approval ids;
/// - the image path of `shelf-photo.png` in the second prompt of "Add stock report images";
/// - the text of that session's first prompt after "2)" (the capture cut it off;
///   completed from the reply, as the mock notes);
/// - the pending `codex.mcp_tool_call` and `AskUserQuestion` tool entries, which the
///   executors write when an approval is requested (codex/normalize_logs.rs);
/// - the Bash rows' commands where only their summary line was captured.
enum ConversationCapture {
    static let worktree = MockCapture.worktree
    static let shelfPhotoPath = "/private/tmp/mm/iso2/.chro/images/shelf-photo.png"
    /// The photo the capture attached (mock `IMG['shelf-photo']`, 220×160 PNG).
    static let shelfPhoto = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAANwAAACgCAIAAADo2JVsAAAEMElEQVR4nO3d30vddRzH8Y8mdbLTRdGqzViMxa7qNgq8q6htd4UKEUTsvpv+jv6CogiioYvdjP0gG3UhK8a6mQRhmiiZUrGgHY4nWBBHxyZH3fQofF8nHg++CH796vlcvHl+f3Dk9K22/rl1699SyjfTV85fvfzL8kJfaev4ur7Zn7mqvl7e31/K4KFnD7z4Wv35l0opAwMP9N1sNFf++uPjydPXZq6nLTdwf+aq+v4X+x997oWnXn/7wccODJRSPvrqix9mp28fAhW5OTfdP3l6aPT9/m9//P7a7HRV64CN/v75+s3pKwPnrk5qJDluXLvcP7uyUPUy4K7mykL7mlIpidJf9QKg04BM8vI7H3ScLzcPxb33dHf8T59/uOV6lJI4Skl1tpk9pSSOUlIdpaRXKCWlshlQSnqFUlIdpaRXKCXVUUp6hVJSnW1mb+2ta7ADn579upQy8sZwfbC25QGNZmv80lQp5dSbr5Y96L/7fzs2W989t1Jm5pfOXJpqrLY2/7Sx2p7Imfml9nF7eyHXlOzUyPHhY0eGZuaXPjt7udFsdTbyYnsijx0ZGjs+XPZGKW1lh+qDtfW5/HXlz41z2TGR253ct7DNepSSXdg4lxMXpxrNVqPZmuhuIrfn7ptu5vLM2iB+8uXkw7WH5haXu5xIzynZ37k8evjgb7/fmFtcPnr44H41cp1SUrqZgY5f2c216X1fVynZtUazdebC1Nzi8qEnHz96+ODc4vL4hfb1ZdknSkk3E7l+ZzN6ov30Z2Lt2/ELU2MndnkSV0r2cSKfefqJ0bURrA/WRk/cfn65X730nNJWdjuRx44MvfvWK3eiWB+sjXU3l9usRynZqTsTObLpNN0xl2VvXFNSdj4D7Yk8ufWFY/2R2tjJ4fHzU7v4g94lxB69N3Kf9/7UB2un7nfMTigl1XH3Ta9QSqqjlPQKpaQ6SkmvUEpKZTOglPQKpaQ6SkmvUEqqo5T0CqWkfHeu/Xk2FXy0slLSK5SSOEpJHKUkjlISRymJo5TEUUriKCVxlJI4SkkcpSSOUhJHKYmjlMRRSuIoJXGUkjhKSRylJI5SEkcpiaOUxFFK4iglcZSSOEpJHKUkjlISRymJo5TEUUriKCVxlJI4SkkcpSSOUhJHKYmjlMRRSuIoJXGUkjhKSRylJI5SEkcpiaOUxFFK4iglcZSSOEpJHKUkjlISRymJo5TEUUriKCVxlJI4SkkcpSSOUhJHKYmjlMRRSuIoJXGUkjhKSRylJI5SEkcpiaOUxFFK4iglcZSSOEpJHKUkjlISRymJo5TEUUriKCVxlJI4SkkcpSSOUhJHKYmjlMRRSuIoJXGUkjhKSRylJI5SEkcpiaOUxFFK4iglcZSSOEpJHKUkjlISRymJo5TEUUriKCVxlJI4SkkcpSSOUhJHKYmjlJQ0/wEhz/tmk+aoWgAAAABJRU5ErkJggg==")!

    static let policyQuestions = [
        QuestionPrompt.Question(
            question: "Which restock policy should the reconciliation use?", header: "Policy",
            options: [.init(label: "Fixed reorder point", description: "Reorder when qty drops below a per-SKU threshold"),
                      .init(label: "Weekly batch", description: "Restock every Monday from last week sales"),
                      .init(label: "Manual only", description: "Never restock automatically")],
            multiSelect: false),
        QuestionPrompt.Question(
            question: "Which events should notify the store manager?", header: "Alerts",
            options: [.init(label: "Stock reaches 0", description: "One message per SKU"),
                      .init(label: "Restock placed", description: "Daily digest"),
                      .init(label: "Negative stock detected", description: "Immediately")],
            multiSelect: true),
    ]

    static let githubApproval = McpApprovalPrompt(
        server: "github", title: "GitHub", message: "Allow the github MCP server to run create_pull_request?", riskLevel: "elevated",
        params: [.init(label: "repo", value: "inventory-service"), .init(label: "title", value: "Add removeStock"), .init(label: "base", value: "main")],
        options: McpDecision.allCases)

    /// Builds entries turn by turn: each `turn` starts a run.
    struct Transcript {
        private(set) var entries: [ConversationEntry] = []
        private var run = ""
        private var index = 0
        let session: String

        init(_ session: String) { self.session = session }

        mutating func turn(_ prompt: String, runWith model: String? = nil) {
            run = "\(session)-run-\(Set(entries.map(\.runID)).count + 1)"
            index = 0
            add(.userMessage(prompt))
            if let model { add(.systemMessage(RunWithLine(model: model, effort: nil).content)) }
        }

        mutating func add(_ kind: ConversationEntryKind) {
            entries.append(ConversationEntry(id: "\(run):\(index)", runID: run, kind: kind))
            index += 1
        }

        mutating func bash(_ command: String, name: String = "Bash", exit: Int? = nil, output: String? = nil) {
            let result = exit.map { CommandResult(exitStatus: .exitCode($0), output: output) }
            add(.toolUse(ToolUse(toolName: name, action: .commandRun(command: command, result: result), status: exit == nil ? .created : .success)))
        }
    }

    static func conversation(_ sessionID: String) -> SessionConversation? {
        let haiku = RuntimeChoice(agent: .claudeCode, model: "Haiku 5.5")
        var t = Transcript(sessionID)
        switch sessionID {
        case "5c1e0f6a-pol":
            t.turn("Use the Bash tool with timeout 600000 to run exactly: for i in $(seq 1 60); do echo scanning sku $i; sleep 10; done. Do not run it in the background. Then say done.", runWith: "Haiku 5.5")
            t.bash("`for i in $(seq 1 60); do echo scanning sku $i; sleep 10; done`", exit: 0, output: "scanning sku 1\nscanning sku 2\n…\nscanning sku 60")
            t.add(.assistantMessage("The loop printed all 60 lines (`scanning sku 1` through `scanning sku 60`).\n\nDone."))
            t.turn("Use the Bash tool with timeout 600000 to run exactly: for i in $(seq 1 55); do echo scanning sku pass 2 $i; sleep 10; done. Foreground only. Then run the same loop once more the same way and ask me which restock policy to use.", runWith: "Haiku 5.5")
            t.bash("for i in $(seq 1 55); do echo scanning sku pass 2 $i; sleep 10; done", exit: 0, output: "scanning sku pass 2 1\n…\nscanning sku pass 2 55")
            t.add(.toolUse(ToolUse(toolName: QuestionPrompt.toolName, action: .tool(name: QuestionPrompt.toolName, arguments: questionsInput(policyQuestions), result: nil),
                                   status: .pendingApproval(approvalID: "approval-5c1e", timeoutAt: nil))))
            return SessionConversation(sessionID: sessionID, entries: t.entries, pendingApproval: .question(approvalID: "approval-5c1e", questions: policyQuestions),
                                       branchStatus: SessionBranchStatus(targetBranch: "main"), runtime: haiku, hasRun: true)
        case "9b07c2d1-rec":
            t.turn("Use the Bash tool with timeout 600000 to run exactly: for i in $(seq 1 60); do echo reconcile batch $i; sleep 10; done. Do not run it in the background. Then say done.", runWith: "Haiku 5.5")
            t.bash("`for i in $(seq 1 60); do echo reconcile batch $i; sleep 10; done`", exit: 143, output: "reconcile batch 1\n…\nreconcile batch 60")
            t.add(.assistantMessage("All 60 batches printed (`reconcile batch 1` through `reconcile batch 60`), but the command was killed at the 10-minute timeout with exit code 143. The loop’s 60 × 10s sleeps add up to 600s, which is right at the limit, so the shell was terminated during the final sleep. The loop itself did not fail.\n\nDone."))
            t.turn("Use the Bash tool with timeout 600000 to run exactly: for i in $(seq 1 55); do echo reconcile pass 2 batch $i; sleep 10; done. Foreground only. Then run the same loop once more the same way and say done.", runWith: "Haiku 5.5")
            t.bash("for i in $(seq 1 55); do echo reconcile pass 2 batch $i; sleep 10; done")
            t.add(.loading(""))
            return SessionConversation(sessionID: sessionID, entries: t.entries, branchStatus: SessionBranchStatus(targetBranch: "main"), runtime: haiku, hasRun: true)
        case "e4a2b9c0-aud":
            t.turn("Run exactly this shell command in the foreground and wait for it: for i in $(seq 1 90); do echo verify sku pass 2 batch $i; sleep 10; done . Then say done.")
            t.add(.assistantMessage("I’ll run the command in the foreground and wait for it to finish."))
            t.bash("/bin/zsh -lc 'for i in $(seq 1 90); do echo verify sku pass 2 batch $i; sleep 10; done'", name: "bash")
            t.add(.toolUse(ToolUse(toolName: McpApprovalPrompt.toolName, action: .tool(name: McpApprovalPrompt.toolName, arguments: nil, result: nil),
                                   status: .pendingApproval(approvalID: "approval-e4a2", timeoutAt: nil), content: "\(McpApprovalPrompt.toolName) (approval pending)")))
            return SessionConversation(sessionID: sessionID, entries: t.entries, pendingApproval: .mcp(approvalID: "approval-e4a2", prompt: githubApproval),
                                       branchStatus: SessionBranchStatus(targetBranch: "main"), runtime: RuntimeChoice(agent: .codex), hasRun: true)
        case "bd50a1e2-img":
            t.turn("Create three small image files for the stock report in this repo, then stop. 1) docs/images/stock-trend.svg: a 240×120 SVG bar chart with 5 colored bars and axis lines. 2) docs/images/warehouse-badge.svg: a 96×96 round blue badge with a white inner ring and white \"WH\" text. 3) docs/images/sku-heatmap.png: a 64×64 RGB gradient from blue to red, written with only zlib and struct.", runWith: "Haiku 5.5")
            t.bash("`mkdir -p docs/images && mkdir -p /tmp…`")
            t.add(.assistantMessage("The PNG was written and deleted the script. The exit code 1 came from the final `ls` on the already-removed script directory, which is expected. Next I'll validate the files and check that only the new files changed."))
            t.bash("`rm -f /tmp/mm-check-trend.png /tmp/mm-check-badge.png; git status --short`")
            t.add(.assistantMessage("I created the three image files under `docs/images/`. No other files changed, and nothing is committed.\n\n- `docs/images/stock-trend.svg`: 240×120 bar chart with x and y axis lines and 5 bars in blue, indigo, light blue, green and orange. I opened the rendered PNG and the bars and axes look right.\n- `docs/images/warehouse-badge.svg`: 96×96 round blue badge with a white inner ring and white \"WH\" text. I checked the render and the letters are centered.\n- `docs/images/sku-heatmap.png`: 64×64 RGB gradient from blue to red, written with `zlib` and `struct` only. I verified the PNG chunk CRCs and the decompressed size, and `file` reports 64 × 64 8-bit RGB.\n\n`docs/` did not exist in this worktree, so I created it along with `docs/images/`. The python script was in `/tmp/mm-png-gen/` and I deleted it afterwards. Git status now shows only `?? docs/`."))
            t.turn(PromptContent.format(text: "What colors are in this photo? Answer in one short sentence, no tools.", references: [],
                                        images: [.init(name: "shelf-photo.png", path: shelfPhotoPath)]), runWith: "Haiku 5.5")
            t.add(.assistantMessage("I can't see the photo: only its file path came through, and you asked me not to use tools to open it. Please attach the image directly so I can name its colors."))
            return SessionConversation(sessionID: sessionID, entries: t.entries, branchStatus: SessionBranchStatus(commitsBehind: 1, targetBranch: "main"), runtime: haiku, hasRun: true)
        case "c4534455-rw":
            t.turn("In README.md, replace the line \"Tracks stock levels per SKU.\" with exactly \"Tracks per-SKU stock levels for the warehouse API.\" Change nothing else, then stop.", runWith: "Haiku 5.5")
            t.bash("`git diff --stat && git diff`")
            t.add(.assistantMessage("I replaced the README.md summary line with \"Tracks per-SKU stock levels for the warehouse API.\" The diff shows only that one line changed. I didn't commit or push anything."))
            return SessionConversation(sessionID: sessionID, entries: t.entries,
                                       branchStatus: SessionBranchStatus(additions: 1, deletions: 1, commitsBehind: 2, targetBranch: "main"), runtime: haiku, hasRun: true)
        case "7a3f5d10-add":
            t.turn("In src/stock.ts add an exported function removeStock(items, sku, amount) that decrements qty but never below 0, and add src/stock.test.ts with two small test cases (plain asserts, no framework).")
            t.add(.assistantMessage("I did not check how the project runs tests, so the `./stock` import and the `node:assert` choice may need adjusting to the project’s setup.\n\nAll changes are uncommitted in `\(worktree)`."))
            t.turn("- **Unknown SKU is a silent no-op.** `items.map` returns the list unchanged when no SKU matches, and the caller gets no signal that the removal did nothing. A typo in the SKU looks like a successful removal.\n- **Negative amount restocks.** `Math.max(0, i.qty - amount)` grows qty when amount is negative.", runWith: "Haiku 5.5")
            t.bash("`git show --stat 539a777074f6aaa228c341da92df8c8ca3e76c27 && git show 539a777074f6aaa228c341da92df8c8ca3e76c27`", exit: 0,
                   output: " src/stock.test.ts | 27 +++++\n src/stock.ts      |  7 ++\n 2 files changed, 34 insertions(+)")
            t.add(.assistantMessage("The branch commit is my own earlier work, auto-committed, with no fixes in it. Its `stock.ts` and `stock.test.ts` match my working tree, so there’s nothing to merge. I’ll apply the two guard fixes from the review to my worktree and leave the design questions open."))
            t.add(.toolUse(ToolUse(toolName: "Edit", action: .fileEdit(path: "src/stock.test.ts", changes: []), status: .success)))
            t.add(.assistantMessage("I applied two of the review’s findings to my worktree, `\(worktree)`. Nothing is committed, and I did not run the tests."))
            return SessionConversation(sessionID: sessionID, entries: t.entries, references: [.init(target: .session(id: "b41c8e33-rev"), relation: .delegatedTo)],
                                       branchStatus: SessionBranchStatus(additions: 35, deletions: 0, targetBranch: "main"), runtime: haiku, hasRun: true)
        case "b41c8e33-rev":
            t.turn("Review removeStock in src/stock.ts for edge cases. Report findings only; do not edit files.", runWith: "Haiku 5.5")
            t.add(.toolUse(ToolUse(toolName: "Read", action: .fileRead(path: "src/stock.ts"), status: .success)))
            t.add(.assistantMessage("- **Unknown SKU is a silent no-op.** `items.map` returns the list unchanged when no SKU matches.\n- **Negative amount silently restocks the item.** `Math.max(0, i.qty - amount)` grows qty when amount is negative."))
            return SessionConversation(sessionID: sessionID, entries: t.entries, references: [.init(target: .session(id: "7a3f5d10-add"), relation: .delegatedFrom)],
                                       branchStatus: SessionBranchStatus(targetBranch: "main"), runtime: haiku, hasRun: true)
        case "4a53c7f9-sum":
            t.turn("Summarize src/stock.ts in one sentence.", runWith: "<synthetic>")
            t.add(.assistantMessage("There’s an issue with the selected model (nonexistent-model-xyz). It may not exist or you may not have access to it. Run --model to pick a different model."))
            t.add(.errorMessage("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"duration_ms\":540,\"result\":\"There's an issue with the selected model (nonexistent-model-xyz). It may not exist or you may not have access to it. Run --model to pick a different model.\",\"error\":null,\"num_turns\":1,\"session_id\":\"9ef32cef-a20c-47a0-a5ae-a1456a7bf665\"}", .other))
            return SessionConversation(sessionID: sessionID, entries: t.entries, branchStatus: SessionBranchStatus(targetBranch: "main"),
                                       runtime: RuntimeChoice(agent: .claudeCode, model: "nonexistent-model-xyz"), hasRun: true)
        default:
            return nil
        }
    }

    /// The conflict "Rebase onto main" stops on for "Reword README summary".
    static let capturedConflicts: [String: SessionBranchStatus.Conflict] = [
        "c4534455-rw": SessionBranchStatus.Conflict(operation: .rebase, files: ["README.md"]),
    ]

    static func questionsInput(_ questions: [QuestionPrompt.Question]) -> JSONValue {
        .object(["questions": .array(questions.map { question in
            .object([
                "question": .string(question.question), "header": .string(question.header), "multiSelect": .bool(question.multiSelect),
                "options": .array(question.options.map { .object(["label": .string($0.label), "description": .string($0.description)]) }),
            ])
        })])
    }
}
