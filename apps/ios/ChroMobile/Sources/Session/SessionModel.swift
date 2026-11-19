import ChroDomain
import ChroServices
import Foundation
import Observation
import UIKit

/// A photo picked for the next prompt: uploaded as soon as it is picked.
struct ImageUpload: Identifiable, Equatable {
    enum State: Equatable {
        case uploading
        case uploaded(UploadedImage)
        case failed(String)
    }

    let id = UUID()
    var name: String
    var data: Data
    var contentType: String
    var state: State
}

/// One session screen's state: the conversation stream, the composer with its
/// uploads and queue, the pending approval's flow, find, and the title edit.
/// Kept per session so a draft survives leaving and reopening the session.
@MainActor @Observable
final class SessionModel {
    let sessionID: String
    let services: ChroServiceContainer
    private(set) var conversation: SessionConversation?
    private(set) var composer: ComposerModel?
    var uploads: [ImageUpload] = []

    /// The pending question's stepped answers, reset when another question arrives.
    private(set) var questionFlow: QuestionFlow?
    private var questionApprovalID: String?
    private(set) var isResponding = false
    private(set) var isStopping = false
    private(set) var isAborting = false
    private(set) var isSubmitting = false
    /// Counts submits: each brings the conversation back to its end (scrollToBottomSignal).
    private(set) var submitCount = 0

    // Conversation presentation
    var stepsOpen: [String: Bool] = [:]
    var toolsOpen: Set<String> = []
    var promptsOpen: Set<String> = []
    /// Each prompt's full text height as last laid out. Kept here, not in the
    /// card, because the lazy conversation recreates a pinned card as it scrolls;
    /// a card that forgot its height would change size and re-place the stack forever.
    var promptTextHeights: [String: CGFloat] = [:]
    var copiedEntryID: String?
    var queueEdit: (id: String, text: String)?

    // Find
    var isFinding = false
    var findQuery = ""
    var findIndex = 0

    // Title
    var isEditingTitle = false
    var titleDraft = ""

    @ObservationIgnored private var subscription: Task<Void, Never>?
    /// The session's project, for the composer's pickers.
    @ObservationIgnored private var composerContext: (projectID: String, isScratch: Bool)?

    init(sessionID: String, services: ChroServiceContainer) {
        self.sessionID = sessionID
        self.services = services
    }

    /// Leaving the screen releases the conversation's streams; the state stays for the next visit.
    func stopFeed() {
        subscription?.cancel()
        subscription = nil
    }

    private(set) var isLoadingEarlier = false

    func loadEarlierHistory() {
        guard !isLoadingEarlier else { return }
        isLoadingEarlier = true
        Task {
            await services.conversation.loadEarlierHistory(sessionID: sessionID)
            isLoadingEarlier = false
        }
    }

    func start(projectID: String, isScratch: Bool) {
        composerContext = (projectID, isScratch)
        if let conversation { makeComposer(conversation) }
        guard subscription == nil else { return }
        subscription = Task { [weak self, services, sessionID] in
            for await value in services.conversation.conversation(sessionID: sessionID) { self?.receive(value) }
        }
    }

    /// A session this phone just started opens on its prompt until the streams carry it.
    func showStarted(prompt: String, runtime: RuntimeChoice) {
        guard conversation == nil, !prompt.isEmpty else { return }
        conversation = .started(sessionID: sessionID, prompt: prompt, runtime: runtime)
    }

    private func receive(_ value: SessionConversation) {
        let value = conversation?.superseded(by: value) ?? value
        conversation = value
        makeComposer(value)
        composer?.runtimeLocked = ExecutorLocks(hasRun: value.hasRun, isRunning: false).runtimeLocked
        if case .question(let id, let questions)? = value.pendingApproval {
            if questionApprovalID != id {
                questionApprovalID = id
                questionFlow = QuestionFlow(questions: questions)
            }
        } else {
            questionApprovalID = nil
            questionFlow = nil
        }
    }

    /// The composer starts from the session's runtime once the conversation has loaded and
    /// the project is known (`composerSeed`).
    private func makeComposer(_ conversation: SessionConversation) {
        guard composer == nil, let context = composerContext, let seed = conversation.composerSeed else { return }
        let created = ComposerModel(projectID: context.projectID, isScratch: context.isScratch, services: services, sessionRuntime: seed)
        created.runtimeLocked = ExecutorLocks(hasRun: conversation.hasRun, isRunning: false).runtimeLocked
        created.photoIntake = { [weak self] reference in self?.addUpload(reference) }
        composer = created
    }

    // MARK: Uploads

    var isUploading: Bool { uploads.contains { $0.state == .uploading } }

    private func addUpload(_ reference: ComposerReference) {
        guard let data = reference.imageData else { return }
        let upload = ImageUpload(name: reference.label, data: data, contentType: reference.label.lowercased().hasSuffix(".png") ? "image/png" : "image/jpeg",
                                 state: .uploading)
        uploads.append(upload)
        runUpload(upload.id)
    }

    func retryUpload(_ id: UUID) {
        guard let index = uploads.firstIndex(where: { $0.id == id }) else { return }
        uploads[index].state = .uploading
        runUpload(id)
    }

    func removeUpload(_ id: UUID) { uploads.removeAll { $0.id == id } }

    /// The failure becomes the tile's state and a toast, as the desktop's warning toast does.
    var onUploadFailure: ((String) -> Void)?

    private func runUpload(_ id: UUID) {
        guard let upload = uploads.first(where: { $0.id == id }) else { return }
        Task {
            let state: ImageUpload.State
            do {
                state = .uploaded(try await services.conversation.uploadImage(sessionID: sessionID, data: upload.data, fileName: upload.name,
                                                                             contentType: upload.contentType))
            } catch {
                let message = Self.message(error)
                state = .failed(message)
                onUploadFailure?("Failed to upload \(upload.name): \(message)")
            }
            if let index = uploads.firstIndex(where: { $0.id == id }) { uploads[index].state = state }
        }
    }

    // MARK: Sending

    func isRunning(_ session: SessionSummary) -> Bool { session.isRunning }

    func sendControls(_ session: SessionSummary) -> SendControls {
        SendControls.resolve(isRunning: session.isRunning, isStopping: isStopping, isEmpty: composer?.isEmpty ?? true, isUploading: isUploading)
    }

    /// The prompt as sent: context, skills, uploaded images, then the text.
    private func composedPrompt() -> (prompt: String, imageIDs: [String])? {
        guard let composer else { return nil }
        let images = uploads.compactMap { upload -> UploadedImage? in
            if case .uploaded(let image) = upload.state { return image }
            return nil
        }
        let references = composer.references.compactMap { reference -> PromptContent.Reference? in
            switch reference.kind {
            case .file: return .init(kind: .file, path: reference.target)
            case .directory: return .init(kind: .directory, path: reference.target)
            case .session: return .init(kind: .session, path: reference.target)
            case .skill: return .init(kind: .skill, path: reference.target)
            case .image: return nil
            }
        }
        let prompt = PromptContent.format(text: composer.text, references: references, images: images.map { .init(name: $0.name, path: $0.path) })
        return prompt.isEmpty ? nil : (prompt, images.map(\.id))
    }

    private func clearDraft() {
        composer?.text = ""
        composer?.references = []
        uploads = []
    }

    /// Send, or queue while a turn runs or earlier messages wait.
    func submit(_ session: SessionSummary) async throws {
        guard !isSubmitting, !isUploading, let composer, !composer.isEmpty, let (prompt, imageIDs) = composedPrompt() else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        submitCount += 1
        switch QueueRules.submitIntent(turnInFlight: session.isRunning, waiting: conversation?.queue.count ?? 0) {
        case .send:
            try await services.conversation.send(sessionID: sessionID, prompt: prompt, runtime: composer.runtime, imageIDs: imageIDs)
        case .queue:
            try await services.conversation.enqueue(sessionID: sessionID, prompt: prompt)
        }
        clearDraft()
    }

    func stop() async throws {
        guard !isStopping else { return }
        isStopping = true
        defer { isStopping = false }
        try await services.conversation.stop(sessionID: sessionID)
    }

    // MARK: Queue

    func saveQueueEdit() async throws {
        guard let edit = queueEdit, let item = conversation?.queue.first(where: { $0.id == edit.id }) else { queueEdit = nil; return }
        let text = edit.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        try await services.conversation.updateQueued(sessionID: sessionID, itemID: item.id, prompt: QueueRules.rewrite(item.prompt, text: text))
        queueEdit = nil
    }

    func removeQueued(_ id: String) async throws { try await services.conversation.removeQueued(sessionID: sessionID, itemID: id) }
    func sendQueuedNow(_ id: String) async throws { try await services.conversation.sendQueuedNow(sessionID: sessionID, itemID: id) }
    func moveQueued(_ id: String, to index: Int) async throws { try await services.conversation.moveQueued(sessionID: sessionID, itemID: id, to: index) }

    // MARK: Approvals

    func updateFlow(_ change: (inout QuestionFlow) -> QuestionOutcome?) {
        guard var flow = questionFlow, case .question(let id, _)? = conversation?.pendingApproval else { return }
        let outcome = change(&flow)
        questionFlow = flow
        if let outcome { respond(approvalID: id, .question(outcome)) }
    }

    func decide(_ decision: McpDecision) {
        guard case .mcp(let id, _)? = conversation?.pendingApproval else { return }
        respond(approvalID: id, .mcp(decision))
    }

    var onActionFailure: ((String, String?) -> Void)?

    private func respond(approvalID: String, _ response: ApprovalResponse) {
        guard !isResponding else { return }
        isResponding = true
        Task {
            defer { isResponding = false }
            do {
                try await services.conversation.respond(sessionID: sessionID, approvalID: approvalID, response: response)
            } catch {
                onActionFailure?("Failed to respond", Self.message(error))
            }
        }
    }

    // MARK: Conflict

    func abortConflict(fallback: String) async -> String? {
        isAborting = true
        defer { isAborting = false }
        do {
            try await services.conversation.abortConflict(sessionID: sessionID)
            return nil
        } catch {
            return GitErrorText.resolve(Self.message(error), fallback: fallback)
        }
    }

    // MARK: Title

    func beginTitleEdit(_ current: String?) {
        titleDraft = current ?? ""
        isEditingTitle = true
    }

    /// Empty or unchanged cancels.
    func commitTitle(_ current: String?) {
        guard isEditingTitle else { return }
        isEditingTitle = false
        let value = titleDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value != current else { return }
        Task {
            do { try await services.conversation.rename(sessionID: sessionID, title: value) } catch {
                onActionFailure?("Failed to rename session", Self.message(error))
            }
        }
    }

    // MARK: Find

    var findMatches: [ConversationFind.Match] {
        guard isFinding, let conversation else { return [] }
        let inherited = conversation.continuation?.nativeEntries ?? []
        return ConversationFind.matches(query: findQuery, in: inherited + conversation.entries)
    }

    var activeMatch: ConversationFind.Match? {
        let matches = findMatches
        return matches.isEmpty ? nil : matches[min(findIndex, matches.count - 1)]
    }

    func stepFind(_ delta: Int) { findIndex = ConversationFind.step(findIndex, by: delta, total: findMatches.count) }

    func toggleFind() {
        isFinding.toggle()
        findQuery = ""
        findIndex = 0
    }

    static func message(_ error: Error) -> String {
        (error as? ServiceError)?.message ?? error.localizedDescription
    }
}

/// Session models outlive their screens, as the desktop keeps a draft per session.
@MainActor
final class SessionModels {
    static let shared = SessionModels()
    private var models: [String: SessionModel] = [:]

    func model(_ sessionID: String, services: ChroServiceContainer) -> SessionModel {
        if let existing = models[sessionID] { return existing }
        let created = SessionModel(sessionID: sessionID, services: services)
        models[sessionID] = created
        return created
    }
}
