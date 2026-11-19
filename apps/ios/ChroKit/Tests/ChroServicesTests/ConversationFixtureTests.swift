import ChroDomain
import Foundation
import Testing
@testable import ChroServices

private let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)

private func workspace() -> FixtureWorkspace {
    FixtureWorkspace(scenario: .standard, now: { fixedNow }, titleDelay: .milliseconds(10))
}

private func current(_ w: FixtureWorkspace, _ id: String) async -> SessionConversation {
    var iterator = w.conversation(sessionID: id).makeAsyncIterator()
    return await iterator.next()!
}

private func summary(_ w: FixtureWorkspace, _ id: String) -> SessionSummary { w.sessionList.value.first { $0.id == id }! }

private func turnShape(_ conversation: SessionConversation) -> [String] {
    ConversationLayout.turns(conversation.entries).map { turn in
        turn.segments.map { segment -> String in
            switch segment {
            case .steps(let steps): return "steps(\(steps.entries.count)\(steps.isLive ? ",live" : ""))"
            case .entry(let entry):
                switch entry.kind {
                case .assistantMessage: return "ai"
                case .systemMessage(let text): return RunWithLine.parse(text) != nil ? "runwith" : "system"
                case .errorMessage: return "error"
                default: return "other"
                }
            }
        }.joined(separator: " ")
    }
}

/// The conversations behind mock slots 5-7 and 11 and the sessions they lead to.
struct CapturedConversationTests {
    @Test func runningSessionMatchesSlotFive() async {
        let c = await current(workspace(), "9b07c2d1-rec")
        #expect(turnShape(c) == ["runwith steps(1) ai", "runwith steps(2,live)"])
        #expect(c.pendingApproval == nil)
        #expect(c.runtime.pillLabel == "Haiku 5.5")
        #expect(ExecutorLocks(hasRun: c.hasRun, isRunning: true).pickerDisabled)
    }

    @Test func mcpApprovalMatchesSlotSix() async {
        let c = await current(workspace(), "e4a2b9c0-aud")
        guard case .mcp(_, let prompt)? = c.pendingApproval else { Issue.record("an MCP approval is pending"); return }
        #expect(prompt.headerLabel == "GitHub · github")
        #expect(prompt.isOutsideSandbox)
        #expect(turnShape(c) == ["ai steps(2,live)"], "the pending tool call keeps the timeline open")
        #expect(c.runtime.pillLabel == "Codex")
    }

    @Test func questionMatchesSlotSeven() async {
        let c = await current(workspace(), "5c1e0f6a-pol")
        guard case .question(_, let questions)? = c.pendingApproval else { Issue.record("a question is pending"); return }
        #expect(questions.map(\.header) == ["Policy", "Alerts"])
        #expect(questions[1].multiSelect)
        #expect(turnShape(c) == ["runwith steps(1) ai", "runwith steps(2,live)"])
    }

    @Test func failedRunMatchesSlotEleven() async {
        let c = await current(workspace(), "4a53c7f9-sum")
        #expect(turnShape(c) == ["runwith ai error"])
        #expect(c.runtime.pillLabel == "nonexistent-model-xyz")
    }

    @Test func referencesAndBranchStatus() async {
        let w = workspace()
        #expect(await current(w, "7a3f5d10-add").references == [SessionReference(target: .session(id: "b41c8e33-rev"), relation: .delegatedTo)])
        #expect(await current(w, "7a3f5d10-add").branchStatus.additions == 35)
        #expect(await current(w, "c4534455-rw").branchStatus.commitsBehind == 2)
        #expect(await current(w, "b41c8e33-rev").references.first?.relation == .delegatedFrom)
    }

    @Test func imagePromptCarriesItsPillAndBytes() async throws {
        let w = workspace()
        let c = await current(w, "bd50a1e2-img")
        let prompts = c.entries.compactMap { $0.kind.userContent }
        #expect(PromptContent.parse(prompts[1]).attachments == [.image(name: "shelf-photo.png", path: ConversationCapture.shelfPhotoPath)])
        let bytes = try await w.image(sessionID: c.sessionID, path: ConversationCapture.shelfPhotoPath)
        #expect(bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]))
    }
}

struct ConversationActionTests {
    @Test func sendStartsALiveTurnAndRunsTheSession() async throws {
        let w = workspace()
        try await w.send(sessionID: "4a53c7f9-sum", prompt: "Try again", runtime: RuntimeChoice(agent: .claudeCode, model: "Opus 5.5", effort: .high), imageIDs: [])
        let c = await current(w, "4a53c7f9-sum")
        #expect(Array(turnShape(c).suffix(1)) == ["runwith steps(1,live)"])
        #expect(c.entries.compactMap { $0.kind.userContent }.last == "Try again")
        #expect(c.entries.contains { $0.kind == .systemMessage("Run with Opus 5.5 reasoning effort: High") })
        #expect(c.runtime.model == "Opus 5.5")
        let s = summary(w, "4a53c7f9-sum")
        #expect(s.isRunning && s.status == "in_progress")
    }

    @Test func aDefaultRuntimeSendsNoRunWithLine() async throws {
        let w = workspace()
        try await w.send(sessionID: "7a3f5d10-add", prompt: "go", runtime: RuntimeChoice(agent: .claudeCode), imageIDs: [])
        #expect(Array(turnShape(await current(w, "7a3f5d10-add")).suffix(1)) == ["steps(1,live)"])
    }

    @Test func queueEditReorderAndSendNow() async throws {
        let w = workspace()
        let id = "9b07c2d1-rec"
        try await w.enqueue(sessionID: id, prompt: "first")
        try await w.enqueue(sessionID: id, prompt: "second")
        var queue = await current(w, id).queue
        #expect(queue.map(\.prompt) == ["first", "second"])
        try await w.updateQueued(sessionID: id, itemID: queue[0].id, prompt: "first, edited")
        try await w.moveQueued(sessionID: id, itemID: queue[1].id, to: 0)
        queue = await current(w, id).queue
        #expect(queue.map(\.prompt) == ["second", "first, edited"])
        try await w.sendQueuedNow(sessionID: id, itemID: queue[1].id)
        let c = await current(w, id)
        #expect(c.queue.map(\.prompt) == ["second"])
        #expect(c.entries.compactMap { $0.kind.userContent }.last == "first, edited")
        #expect(turnShape(c) == ["runwith steps(1) ai", "runwith steps(1)", "runwith steps(1,live)"], "the interrupted turn stops being live")
        try await w.removeQueued(sessionID: id, itemID: queue[0].id)
        #expect(await current(w, id).queue.isEmpty)
    }

    @Test func stopCancelsTheTurnAndInterruptsTheQuestion() async throws {
        let w = workspace()
        try await w.stop(sessionID: "5c1e0f6a-pol")
        let c = await current(w, "5c1e0f6a-pol")
        #expect(c.pendingApproval == nil)
        let s = summary(w, "5c1e0f6a-pol")
        #expect(!s.isRunning && !s.awaitingInput && s.status == "cancelled")
        let ask = c.entries.compactMap { entry -> ToolUse? in if case .toolUse(let tool) = entry.kind, tool.toolName == QuestionPrompt.toolName { return tool } else { return nil } }.first!
        #expect(QuestionTranscript.derive(questions: ConversationCapture.policyQuestions, isPending: ask.status.isPendingApproval, isDialogShown: false, result: nil, isError: false)
            == .status(label: "Policy", status: "Interrupted"))
    }

    @Test func answeringTheQuestionResumesTheRun() async throws {
        let w = workspace()
        let pairs = [QuestionAnswerPair(question: ConversationCapture.policyQuestions[0].question, answer: "Weekly batch")]
        try await w.respond(sessionID: "5c1e0f6a-pol", approvalID: "approval-5c1e", response: .question(.answered(pairs)))
        let c = await current(w, "5c1e0f6a-pol")
        #expect(c.pendingApproval == nil)
        #expect(!summary(w, "5c1e0f6a-pol").awaitingInput)
        #expect(Array(turnShape(c).suffix(1)) == ["runwith steps(3,live)"])
        guard case .toolUse(let ask) = c.entries.first(where: { if case .toolUse(let t) = $0.kind { return t.toolName == QuestionPrompt.toolName } else { return false } })!.kind,
              case .tool(_, _, let result) = ask.action else { Issue.record("the question row"); return }
        #expect(QuestionTranscript.derive(questions: ConversationCapture.policyQuestions, isPending: false, isDialogShown: false, result: result, isError: false) == .answered(pairs))
    }

    @Test func skippingEveryQuestionDeniesTheCall() async throws {
        let w = workspace()
        try await w.respond(sessionID: "5c1e0f6a-pol", approvalID: "approval-5c1e", response: .question(.skipped))
        let c = await current(w, "5c1e0f6a-pol")
        let ask = c.entries.compactMap { entry -> ToolUse? in if case .toolUse(let tool) = entry.kind, tool.toolName == QuestionPrompt.toolName { return tool } else { return nil } }.first!
        guard case .tool(_, _, let result) = ask.action else { return }
        #expect(QuestionTranscript.derive(questions: ConversationCapture.policyQuestions, isPending: false, isDialogShown: false, result: result, isError: true)
            == .status(label: "Policy", status: "Skipped"))
    }

    @Test func mcpDecisionsResolveTheApproval() async throws {
        let w = workspace()
        try await w.respond(sessionID: "e4a2b9c0-aud", approvalID: "approval-e4a2", response: .mcp(.deny))
        let c = await current(w, "e4a2b9c0-aud")
        #expect(c.pendingApproval == nil)
        #expect(c.entries.contains { if case .toolUse(let t) = $0.kind { return t.status == .denied(reason: nil) } else { return false } })
        await #expect(throws: ServiceError.self) {
            try await w.respond(sessionID: "e4a2b9c0-aud", approvalID: "approval-e4a2", response: .mcp(.allow))
        }
    }

    @Test func renameUpdatesTheList() async throws {
        let w = workspace()
        try await w.rename(sessionID: "7a3f5d10-add", title: "  Stock guards  ")
        #expect(summary(w, "7a3f5d10-add").title == "Stock guards")
        await #expect(throws: ServiceError.self) { try await w.rename(sessionID: "7a3f5d10-add", title: "  ") }
    }

    @Test func continuingFromATurnInheritsHistoryUpToIt() async throws {
        let w = workspace()
        let source = await current(w, "7a3f5d10-add")
        let firstRun = source.entries[0].runID
        let forked = try await w.continueFromRun(sessionID: "7a3f5d10-add", runID: firstRun)
        #expect(forked.title == "Add removeStock to stock module (2)")
        let c = await current(w, forked.id)
        #expect(c.entries.isEmpty)
        #expect(!c.hasRun)
        guard case .native(let inherited)? = c.continuation?.history else { Issue.record("native history"); return }
        #expect(Set(inherited.map(\.runID)) == [firstRun])
        #expect(inherited.allSatisfy { $0.isInherited })
        #expect(c.references == [SessionReference(target: .session(id: "7a3f5d10-add"), relation: .continuedFrom)])
        #expect(await current(w, "7a3f5d10-add").references.contains(SessionReference(target: .session(id: forked.id), relation: .continuedIn)))
        #expect(c.branchStatus.additions == 35, "the same checkout keeps the diff")
        #expect(c.branchStatus.targetBranch == nil, "no run, so no run target yet")
    }

    @Test func continuingFromTheListInheritsEverything() async throws {
        let w = workspace()
        let forked = try await w.continueSession(sessionID: "bd50a1e2-img", in: .newWorktree)
        let c = await current(w, forked.id)
        guard case .native(let inherited)? = c.continuation?.history else { Issue.record("native history"); return }
        #expect(inherited.count == (await current(w, "bd50a1e2-img")).entries.count)
        #expect(c.branchStatus.commitsBehind == 0, "a new worktree starts clean")
    }

    @Test func aNewSessionShowsItsFirstPrompt() async throws {
        let w = workspace()
        let session = try await w.startSession(NewSessionRequest(projectID: "inv", prompt: "Add a README", runtime: RuntimeChoice(agent: .claudeCode, model: "Sonnet 5.5"),
                                                                 baseBranch: "main", useWorktree: true))
        let c = await current(w, session.id)
        #expect(turnShape(c) == ["runwith steps(1,live)"])
        #expect(c.entries.first?.kind == .userMessage("Add a README"))
    }

    @Test func conflictAndAbort() async throws {
        let w = workspace()
        #expect(w.enterCapturedConflict(sessionID: "c4534455-rw"))
        #expect(await current(w, "c4534455-rw").branchStatus.conflict == SessionBranchStatus.Conflict(operation: .rebase, files: ["README.md"]))
        try await w.abortConflict(sessionID: "c4534455-rw")
        #expect(await current(w, "c4534455-rw").branchStatus.conflict == nil)
        #expect(!w.enterCapturedConflict(sessionID: "7a3f5d10-add"), "no conflict was captured there")
    }

    @Test func uploadsAcceptTheServersImageFormats() async throws {
        let w = workspace()
        let image = try await w.uploadImage(sessionID: "bd50a1e2-img", data: Data([1, 2, 3]), fileName: "photo-1.jpg", contentType: "image/jpeg")
        #expect(image.name == "photo-1.jpg")
        #expect(try await w.image(sessionID: "bd50a1e2-img", path: image.path) == Data([1, 2, 3]))
        await #expect(throws: ServiceError.invalid("unsupported image format")) {
            _ = try await w.uploadImage(sessionID: "bd50a1e2-img", data: Data([1]), fileName: "IMG_0412.DNG", contentType: "image/x-adobe-dng")
        }
    }
}

/// `-ChroReplyPace`: the fixture's agent answers a sent turn step by step, as a
/// real run streams, so the screen's working state and follow-bottom can be watched.
struct FixtureReplyTests {
    @Test func aSentTurnStreamsItsStepsBehindTheWorkingSentinelThenEnds() async throws {
        let w = FixtureWorkspace(scenario: .standard, now: { fixedNow }, titleDelay: .milliseconds(10), replyPace: .milliseconds(5))
        let id = "c4534455-rw"
        var seen: [SessionConversation] = []
        let reader = Task { () -> [SessionConversation] in
            var values: [SessionConversation] = []
            for await value in w.conversation(sessionID: id) {
                values.append(value)
                if case .assistantMessage(let text)? = value.entries.last?.kind, text == FixtureWorkspace.replyClosing { break }
            }
            return values
        }
        try await w.send(sessionID: id, prompt: "Work through it", runtime: RuntimeChoice(agent: .claudeCode), imageIDs: [])
        seen = await reader.value
        let during = seen.filter { $0.entries.contains { $0.kind.userContent == "Work through it" } }.dropLast()
        #expect(during.count > FixtureWorkspace.replySteps, "one value per step")
        #expect(during.allSatisfy { $0.entries.last?.kind == .loading("") }, "the sentinel trails every step")
        #expect(!(seen.last?.entries.contains { if case .loading = $0.kind { true } else { false } } ?? true))
        try await eventuallyTrue { !summary(w, id).isRunning }
    }

    @Test func withoutAPaceTheTurnStaysAtWork() async throws {
        let w = workspace()
        try await w.send(sessionID: "c4534455-rw", prompt: "Hold", runtime: RuntimeChoice(agent: .claudeCode), imageIDs: [])
        try await Task.sleep(for: .milliseconds(50))
        #expect(await current(w, "c4534455-rw").entries.last?.kind == .loading(""))
        #expect(summary(w, "c4534455-rw").isRunning)
    }
}

private func eventuallyTrue(_ condition: () -> Bool) async throws {
    for _ in 0..<200 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("condition never held")
}
