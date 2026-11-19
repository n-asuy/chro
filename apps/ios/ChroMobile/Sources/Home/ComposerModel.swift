import ChroDomain
import ChroServices
import Foundation
import Observation

/// The state of one composer: the draft, its context references, and what
/// the session runs with. Home and New session share it per project; the
/// conversation screen can drive the same view with its own model.
@MainActor @Observable
final class ComposerModel {
    let projectID: String
    let isScratch: Bool
    let services: ChroServiceContainer

    var text = ""
    var references: [ComposerReference] = []
    var runtime = RuntimeChoice(agent: .claudeCode)
    /// "From": the branch a worktree starts from.
    var baseBranch = "main"
    var useWorktree = true
    private(set) var models: [ModelOption] = []
    private(set) var isSending = false
    /// A session that has run keeps its runtime: models of other runtimes are offered disabled.
    var runtimeLocked = false
    /// When set, picked photos go here instead of becoming pills (the conversation uploads them first).
    @ObservationIgnored var photoIntake: (@MainActor (ComposerReference) -> Void)?
    /// The composer of an existing session starts from that session's runtime, not the default.
    private let followsSession: Bool

    init(projectID: String, isScratch: Bool, services: ChroServiceContainer, sessionRuntime: RuntimeChoice? = nil) {
        self.projectID = projectID
        self.isScratch = isScratch
        self.services = services
        followsSession = sessionRuntime != nil
        if let sessionRuntime { runtime = sessionRuntime }
    }

    func load() async {
        if models.isEmpty { models = (try? await services.composer.models()) ?? [] }
        if !followsSession, text.isEmpty, references.isEmpty, runtime.model == nil, let runtime = try? await services.composer.defaultRuntime() {
            self.runtime = runtime
        }
    }

    var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && references.isEmpty }
    var canSend: Bool { !isEmpty && !isSending }

    var efforts: [Effort] { runtime.efforts(in: models) }
    var supportsFastSpeed: Bool { runtime.supportsFastSpeed(in: models) }

    func pick(model: ModelOption) { runtime.pick(model) }

    func attach(_ reference: ComposerReference) {
        if reference.kind == .image, let photoIntake {
            photoIntake(reference)
            return
        }
        if !references.contains(where: { $0.id == reference.id }) { references.append(reference) }
    }

    func detach(_ reference: ComposerReference) { references.removeAll { $0.id == reference.id } }

    /// The `@`/`/` the user typed to open the picker is replaced by the pill.
    func consumeTrigger() {
        if text.hasSuffix("@") || text.hasSuffix("/") { text.removeLast() }
    }

    /// Start the session; on success the draft is cleared.
    func send() async throws -> SessionSummary {
        guard canSend else { throw ServiceError.invalid("A prompt is required.") }
        isSending = true
        defer { isSending = false }
        let request = NewSessionRequest(projectID: projectID, prompt: text.trimmingCharacters(in: .whitespacesAndNewlines), runtime: runtime,
                                        baseBranch: isScratch ? nil : baseBranch, useWorktree: !isScratch && useWorktree, references: references)
        let session = try await services.sessions.startSession(request)
        text = ""
        references = []
        return session
    }
}

/// Composer drafts survive leaving and reopening a project's launcher.
@MainActor @Observable
final class ComposerDrafts {
    private var models: [String: ComposerModel] = [:]

    func model(projectID: String, isScratch: Bool, services: ChroServiceContainer) -> ComposerModel {
        if let existing = models[projectID] { return existing }
        let created = ComposerModel(projectID: projectID, isScratch: isScratch, services: services)
        models[projectID] = created
        return created
    }
}
