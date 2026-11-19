import ChroAPI
import ChroDomain
import Foundation

/// The fixture's conversations: the captured ones, and those of sessions the
/// user starts or continues while the app runs on the fixture.
final class FixtureConversations: @unchecked Sendable {
    private struct Continuation {
        var sourceID: String
        var anchorRunID: String?
        var checkout: ContinuationCheckout
    }

    private let lock = NSLock()
    private var broadcasts: [String: ServiceBroadcast<SessionConversation>] = [:]
    private var starts: [String: NewSessionRequest] = [:]
    private var continuations: [String: Continuation] = [:]
    private var images: [String: Data] = [ConversationCapture.shelfPhotoPath: ConversationCapture.shelfPhoto]

    func recordStart(of session: SessionSummary, request: NewSessionRequest) {
        lock.withLock { starts[session.id] = request }
    }

    func recordContinuation(of sourceID: String, as sessionID: String, checkout: ContinuationCheckout) {
        lock.withLock { continuations[sessionID] = Continuation(sourceID: sourceID, anchorRunID: nil, checkout: checkout) }
    }

    func anchorContinuation(_ sessionID: String, at runID: String) {
        lock.withLock { continuations[sessionID]?.anchorRunID = runID }
    }

    func storeImage(_ data: Data, at path: String) { lock.withLock { images[path] = data } }
    func image(at path: String) -> Data? { lock.withLock { images[path] } }

    /// The session's broadcast, seeded on first use.
    func broadcast(_ sessionID: String, seed: () -> SessionConversation) -> ServiceBroadcast<SessionConversation> {
        if let existing = lock.withLock({ broadcasts[sessionID] }) { return existing }
        let created = ServiceBroadcast(seed())
        return lock.withLock {
            if let raced = broadcasts[sessionID] { return raced }
            broadcasts[sessionID] = created
            return created
        }
    }

    func start(of sessionID: String) -> NewSessionRequest? { lock.withLock { starts[sessionID] } }
    func continuation(of sessionID: String) -> (sourceID: String, anchorRunID: String?, checkout: ContinuationCheckout)? {
        lock.withLock { continuations[sessionID].map { ($0.sourceID, $0.anchorRunID, $0.checkout) } }
    }
}

extension FixtureWorkspace: ConversationService {
    /// How long a fixture action takes, so its in-progress state is visible.
    private var actionLatency: Duration { min(titleDelay, .milliseconds(700)) }

    private func summary(_ sessionID: String) throws -> SessionSummary {
        guard let session = sessionList.value.first(where: { $0.id == sessionID }) else { throw ServiceError.notFound("Session") }
        return session
    }

    private func updateSession(_ sessionID: String, _ change: (inout SessionSummary) -> Void) {
        sessionList.update { list in
            if let index = list.firstIndex(where: { $0.id == sessionID }) { change(&list[index]) }
        }
    }

    func conversationBroadcast(_ sessionID: String) -> ServiceBroadcast<SessionConversation> {
        conversationState.broadcast(sessionID) { seedConversation(sessionID) }
    }

    private func seedConversation(_ sessionID: String) -> SessionConversation {
        if let captured = ConversationCapture.conversation(sessionID) { return captured }
        let session = sessionList.value.first { $0.id == sessionID }
        let runtime = RuntimeChoice(agent: session?.agent ?? .claudeCode, model: session?.model)
        if let start = conversationState.start(of: sessionID) {
            var conversation = SessionConversation(sessionID: sessionID, branchStatus: SessionBranchStatus(targetBranch: start.baseBranch),
                                                   usesWorktree: start.useWorktree, runtime: start.runtime, hasRun: true)
            Self.startTurn(&conversation, prompt: start.prompt, runtime: start.runtime)
            return conversation
        }
        if let origin = conversationState.continuation(of: sessionID) {
            let source = conversationBroadcast(origin.sourceID).value
            let sourceSession = sessionList.value.first { $0.id == origin.sourceID }
            let inherited = ContinuationOrigin.inheritedEntries((source.continuation?.nativeEntries ?? []) + source.entries,
                                                                anchorRunID: origin.anchorRunID)
            conversationBroadcast(origin.sourceID).update { $0.references.append(SessionReference(target: .session(id: sessionID), relation: .continuedIn)) }
            let sameCheckout = origin.checkout == .sameCheckout
            return SessionConversation(
                sessionID: sessionID,
                continuation: ContinuationOrigin(sourceSessionID: origin.sourceID, sourceTitle: sourceSession?.title, history: .native(inherited)),
                references: [SessionReference(target: .session(id: origin.sourceID), relation: .continuedFrom)],
                // Idle until the first send: no run, so no run target and nothing behind it yet.
                branchStatus: sameCheckout ? SessionBranchStatus(additions: source.branchStatus.additions, deletions: source.branchStatus.deletions) : SessionBranchStatus(),
                usesWorktree: source.usesWorktree, runtime: RuntimeChoice(agent: source.runtime.agent), hasRun: false)
        }
        return SessionConversation(sessionID: sessionID, runtime: runtime, hasRun: session.map { $0.isRunning || $0.status != "pending" } ?? false)
    }

    /// Appends a turn the way the server records one: the prompt, the "Run with"
    /// line when the turn overrides the model or effort, and the working sentinel.
    private static func startTurn(_ conversation: inout SessionConversation, prompt: String, runtime: RuntimeChoice) {
        let run = "\(conversation.sessionID)-run-\(Set(conversation.entries.map(\.runID)).count + 1)"
        var index = 0
        func add(_ kind: ConversationEntryKind) {
            conversation.entries.append(ConversationEntry(id: "\(run):\(index)", runID: run, kind: kind))
            index += 1
        }
        add(.userMessage(prompt))
        if runtime.model != nil || runtime.effort != nil {
            add(.systemMessage(RunWithLine(model: runtime.pillLabel, effort: runtime.effort?.label).content))
        }
        add(.loading(""))
        conversation.runtime = runtime
        conversation.hasRun = true
    }

    /// The running turn ends: its working sentinel goes, pending approvals lapse.
    private static func endLive(_ conversation: inout SessionConversation) {
        conversation.entries.removeAll { if case .loading = $0.kind { return true } else { return false } }
        for index in conversation.entries.indices {
            if case .toolUse(var tool) = conversation.entries[index].kind, tool.status.isPendingApproval {
                tool.status = .created
                conversation.entries[index].kind = .toolUse(tool)
            }
        }
        conversation.pendingApproval = nil
    }

    private static func appendWorking(_ conversation: inout SessionConversation) {
        guard let run = conversation.entries.last?.runID else { return }
        let index = conversation.entries.filter { $0.runID == run }.count
        conversation.entries.append(ConversationEntry(id: "\(run):\(index)", runID: run, kind: .loading("")))
    }

    public func conversation(sessionID: String) -> AsyncStream<SessionConversation> {
        conversationBroadcast(sessionID).stream()
    }

    /// The captured conversations are complete; there is nothing earlier to load.
    public func loadEarlierHistory(sessionID: String) async {}

    public func send(sessionID: String, prompt: String, runtime: RuntimeChoice, imageIDs: [String]) async throws {
        let session = try summary(sessionID)
        guard !session.isRunning else { throw ServiceError.refused("Failed to send message") }
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ServiceError.invalid("A prompt is required.") }
        conversationBroadcast(sessionID).update { Self.startTurn(&$0, prompt: prompt, runtime: runtime) }
        let at = now()
        updateSession(sessionID) { session in
            session.isRunning = true
            session.awaitingInput = false
            session.status = "in_progress"
            session.model = runtime.model
            session.updatedAt = at
        }
        if let replyPace { reply(sessionID, pace: replyPace) }
    }

    /// How many steps the fixture's agent takes to answer, and what it ends with.
    public static let replySteps = 12
    public static let replyClosing = "All \(replySteps) batches are reconciled."

    /// The fixture's agent at work: a command and a note per batch, each landing
    /// in front of the working sentinel as a real run's entries do, then the turn ends.
    private func reply(_ sessionID: String, pace: Duration) {
        Task {
            for batch in 1...Self.replySteps {
                try? await Task.sleep(for: pace)
                guard (try? summary(sessionID).isRunning) == true else { return }
                conversationBroadcast(sessionID).update { conversation in
                    guard let sentinel = conversation.entries.lastIndex(where: { if case .loading = $0.kind { true } else { false } }) else { return }
                    let run = conversation.entries[sentinel].runID
                    let entries: [ConversationEntryKind] = [
                        .toolUse(ToolUse(toolName: "Bash", action: .commandRun(command: "./reconcile --batch \(batch)", result: CommandResult(exitStatus: .exitCode(0), output: "batch \(batch): 5 SKUs matched")),
                                         status: .success)),
                        .assistantMessage("Batch \(batch) matched all five SKUs against the ledger.\n\nNo counts needed a correction, so I moved on to batch \(batch + 1)."),
                    ]
                    let base = conversation.entries.filter { $0.runID == run }.count
                    conversation.entries.insert(contentsOf: entries.enumerated().map { offset, kind in
                        ConversationEntry(id: "\(run):reply-\(base + offset)", runID: run, kind: kind)
                    }, at: sentinel)
                }
            }
            try? await Task.sleep(for: pace)
            guard (try? summary(sessionID).isRunning) == true else { return }
            conversationBroadcast(sessionID).update { conversation in
                Self.endLive(&conversation)
                guard let run = conversation.entries.last?.runID else { return }
                conversation.entries.append(ConversationEntry(id: "\(run):reply-closing", runID: run, kind: .assistantMessage(Self.replyClosing)))
            }
            let at = now()
            updateSession(sessionID) { session in
                session.isRunning = false
                session.status = "completed"
                session.updatedAt = at
            }
        }
    }

    public func enqueue(sessionID: String, prompt: String) async throws {
        _ = try summary(sessionID)
        conversationBroadcast(sessionID).update { $0.queue.append(QueuedPrompt(id: UUID().uuidString.lowercased(), prompt: prompt)) }
    }

    private func queued(_ sessionID: String, _ itemID: String) throws -> Int {
        guard let index = conversationBroadcast(sessionID).value.queue.firstIndex(where: { $0.id == itemID }) else {
            throw ServiceError.notFound("Queued message")
        }
        return index
    }

    public func updateQueued(sessionID: String, itemID: String, prompt: String) async throws {
        let index = try queued(sessionID, itemID)
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw ServiceError.invalid("A prompt is required.") }
        conversationBroadcast(sessionID).update { $0.queue[index].prompt = text }
    }

    public func removeQueued(sessionID: String, itemID: String) async throws {
        let index = try queued(sessionID, itemID)
        conversationBroadcast(sessionID).update { _ = $0.queue.remove(at: index) }
    }

    public func moveQueued(sessionID: String, itemID: String, to target: Int) async throws {
        let index = try queued(sessionID, itemID)
        conversationBroadcast(sessionID).update { conversation in
            let item = conversation.queue.remove(at: index)
            conversation.queue.insert(item, at: min(max(0, target), conversation.queue.count))
        }
    }

    public func sendQueuedNow(sessionID: String, itemID: String) async throws {
        let index = try queued(sessionID, itemID)
        let at = now()
        conversationBroadcast(sessionID).update { conversation in
            let item = conversation.queue.remove(at: index)
            Self.endLive(&conversation)
            Self.startTurn(&conversation, prompt: item.prompt, runtime: conversation.runtime)
        }
        updateSession(sessionID) { session in
            session.isRunning = true
            session.awaitingInput = false
            session.status = "in_progress"
            session.updatedAt = at
        }
    }

    public func stop(sessionID: String) async throws {
        guard try summary(sessionID).isRunning else { return }
        try? await Task.sleep(for: actionLatency)
        conversationBroadcast(sessionID).update { Self.endLive(&$0) }
        updateSession(sessionID) { session in
            session.isRunning = false
            session.awaitingInput = false
            session.status = "cancelled"
        }
    }

    public func respond(sessionID: String, approvalID: String, response: ApprovalResponse) async throws {
        let broadcast = conversationBroadcast(sessionID)
        guard broadcast.value.pendingApproval?.approvalID == approvalID else { throw ServiceError.notFound("Approval") }
        try? await Task.sleep(for: actionLatency)
        broadcast.update { conversation in
            for index in conversation.entries.indices {
                guard case .toolUse(var tool) = conversation.entries[index].kind,
                      case .pendingApproval(let id, _) = tool.status, id == approvalID else { continue }
                switch response {
                case .question(.answered(let pairs)):
                    tool.status = .success
                    tool.action = .tool(name: tool.toolName, arguments: Self.arguments(of: tool),
                                        result: .object(["answers": .object(Dictionary(pairs.map { ($0.question, JSONValue.string($0.answer)) }, uniquingKeysWith: { a, _ in a }))]))
                case .question(.skipped):
                    tool.status = .denied(reason: QuestionPrompt.skippedMessage)
                    tool.action = .tool(name: tool.toolName, arguments: Self.arguments(of: tool), result: .string(QuestionPrompt.skippedMessage))
                case .mcp(let decision):
                    tool.status = decision.approves ? .success : .denied(reason: nil)
                    tool.content = tool.toolName
                }
                conversation.entries[index].kind = .toolUse(tool)
            }
            conversation.pendingApproval = nil
            Self.appendWorking(&conversation)
        }
        updateSession(sessionID) { $0.awaitingInput = false }
    }

    private static func arguments(of tool: ToolUse) -> JSONValue? {
        if case .tool(_, let arguments, _) = tool.action { return arguments }
        return nil
    }

    public func rename(sessionID: String, title: String) async throws {
        _ = try summary(sessionID)
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ServiceError.invalid("A title is required.") }
        updateSession(sessionID) { $0.title = trimmed }
    }

    public func continueFromRun(sessionID: String, runID: String) async throws -> SessionSummary {
        guard conversationBroadcast(sessionID).value.entries.contains(where: { $0.runID == runID }) else { throw ServiceError.notFound("Run") }
        let session = try await continueSession(sessionID: sessionID, in: .sameCheckout)
        conversationState.anchorContinuation(session.id, at: runID)
        return session
    }

    public func abortConflict(sessionID: String) async throws {
        guard conversationBroadcast(sessionID).value.branchStatus.conflict != nil else { throw ServiceError.refused("No conflict to abort") }
        try? await Task.sleep(for: actionLatency)
        conversationBroadcast(sessionID).update { $0.branchStatus.conflict = nil }
    }

    /// Stops "Rebase onto main" on the conflict the capture recorded for this
    /// session; false when none was captured. The Source Control fixture calls
    /// this for its captured rebase outcome.
    @discardableResult
    public func enterCapturedConflict(sessionID: String) -> Bool {
        guard let conflict = ConversationCapture.capturedConflicts[sessionID] else { return false }
        conversationBroadcast(sessionID).update { $0.branchStatus.conflict = conflict }
        return true
    }

    /// The server accepts png, jpg, gif, webp, bmp and svg, by file name (crates/image).
    static let acceptedImageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]

    public func uploadImage(sessionID: String, data: Data, fileName: String, contentType: String) async throws -> UploadedImage {
        _ = try summary(sessionID)
        try? await Task.sleep(for: actionLatency)
        let ext = (fileName as NSString).pathExtension.lowercased()
        guard Self.acceptedImageExtensions.contains(ext) else { throw ServiceError.invalid("unsupported image format") }
        let id = UUID().uuidString.lowercased()
        let path = "/private/tmp/mm/iso2/.chro/images/\(id)-\(fileName)"
        conversationState.storeImage(data, at: path)
        return UploadedImage(id: id, name: fileName, path: path)
    }

    public func image(sessionID: String, path: String) async throws -> Data {
        guard let data = conversationState.image(at: path) else { throw ServiceError.notFound("Image") }
        return data
    }
}
