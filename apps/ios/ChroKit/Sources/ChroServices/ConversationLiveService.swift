import ChroAPI
import ChroDomain
import ChroLink
import Foundation

/// The conversation over the link, with the routes the desktop's session view calls.
extension LiveWorkspace: ConversationService {
    public func conversation(sessionID: String) -> AsyncStream<SessionConversation> {
        conversations.stream(sessionID, workspace: self)
    }

    public func loadEarlierHistory(sessionID: String) async {
        conversations.existing(sessionID)?.loadEarlierHistory()
    }

    // MARK: Runs

    private struct RunList: Decodable { let runs: [JSONValue] }

    /// The session's runs, oldest first: from the open feed, else `GET /rpc/tasks/:id/runs`.
    private func runs(_ sessionID: String) async throws -> [ConversationWire.Run] {
        if let feed = conversations.existing(sessionID), !feed.runs.isEmpty { return feed.runs }
        return try await json(RunList.self, RawRequest(path: RawRequest.path("rpc", "tasks", sessionID, "runs"))).runs
            .compactMap(ConversationWire.Run.init).sorted { $0.createdAt < $1.createdAt }
    }

    /// The run Stop cancels: the running or pending one, else the newest (session-run-state.ts).
    private func activeRun(_ sessionID: String) async throws -> ConversationWire.Run? {
        let all = try await runs(sessionID)
        return all.last { $0.isActive } ?? all.last
    }

    /// A 2xx answer, or the error text the desktop would show.
    @discardableResult
    private func expectSuccess(_ request: RawRequest) async throws -> RawResponse {
        let response = try await send(request)
        guard response.isSuccess else {
            if case .text(_, _, let text) = response { throw ServiceError.refused(text.isEmpty ? "HTTP \(response.status)" : text) }
            if case .json(_, let body) = response, let value = try? JSONDecoder().decode(JSONValue.self, from: body),
               let message = value["error"]?["message"]?.stringValue ?? value["message"]?.stringValue ?? value["error"]?.stringValue {
                throw ServiceError.refused(message)
            }
            throw ServiceError.refused("HTTP \(response.status)")
        }
        return response
    }

    private static func json(_ value: JSONValue) -> Data { try! JSONEncoder().encode(value) }

    // MARK: Sending

    /// `POST /rpc/tasks/:id/messages` / `…/queue` body: the prompt, the runtime,
    /// uploaded images, and the prompt's context refs and skills.
    private func messageBody(sessionID: String, prompt: String, runtime: RuntimeChoice, imageIDs: [String]) async throws -> Data {
        let attachments = PromptContent.parse(prompt).attachments
        let refs = attachments.compactMap { attachment -> ContextRef? in
            switch attachment {
            case .file(let path, let isDirectory):
                return ContextRef(ComposerReference(kind: isDirectory ? .directory : .file, label: path, target: path))
            case .session(let taskID):
                return ContextRef(ComposerReference(kind: .session, label: taskID, target: taskID))
            case .annotations(let path, _):
                return ContextRef(ComposerReference(kind: .file, label: path, target: path))
            case .skill, .image:
                return nil
            }
        }
        let skillNames = attachments.compactMap { if case .skill(let name) = $0 { return name } else { return nil } }
        var skillIDs: [String] = []
        if !skillNames.isEmpty, let projectID = locked({ taskRows[sessionID]?.projectId }),
           let rows = try? await skillRows(projectID: projectID) {
            skillIDs = skillNames.compactMap { name in rows.first { $0.name == name }?.id }
        }
        let run = try? await activeRun(sessionID)
        let message = TaskMessage(
            prompt: prompt,
            executorProfileId: try await executorProfile(runtime),
            imageIds: imageIDs.isEmpty ? nil : imageIDs,
            useWorktree: run.map { $0.containerRef != nil } ?? true,
            targetBranch: run?.targetBranch,
            selectedSkillIds: skillIDs,
            contextRefs: refs
        )
        return Self.body(message)
    }

    public func send(sessionID: String, prompt: String, runtime: RuntimeChoice, imageIDs: [String]) async throws {
        let body = try await messageBody(sessionID: sessionID, prompt: prompt, runtime: runtime, imageIDs: imageIDs)
        try await expectSuccess(RawRequest(method: .post, path: RawRequest.path("rpc", "tasks", sessionID, "messages"), body: body))
    }

    public func enqueue(sessionID: String, prompt: String) async throws {
        let runtime: RuntimeChoice
        if let current = conversations.existing(sessionID)?.broadcast.value.runtime { runtime = current } else { runtime = try await defaultRuntime() }
        let body = try await messageBody(sessionID: sessionID, prompt: prompt, runtime: runtime, imageIDs: [])
        try await expectSuccess(RawRequest(method: .post, path: RawRequest.path("rpc", "tasks", sessionID, "queue"), body: body))
    }

    public func updateQueued(sessionID: String, itemID: String, prompt: String) async throws {
        try await expectSuccess(RawRequest(method: .patch, path: RawRequest.path("rpc", "tasks", sessionID, "queue", itemID),
                                           body: Self.json(.object(["prompt": .string(prompt)]))))
    }

    public func removeQueued(sessionID: String, itemID: String) async throws {
        try await expectSuccess(RawRequest(method: .delete, path: RawRequest.path("rpc", "tasks", sessionID, "queue", itemID)))
    }

    /// `PUT /rpc/tasks/:id/queue {item_ids}`: the whole order.
    public func moveQueued(sessionID: String, itemID: String, to index: Int) async throws {
        let ids = conversations.existing(sessionID)?.broadcast.value.queue.map(\.id) ?? []
        guard ids.contains(itemID) else { throw ServiceError.notFound("Queued message") }
        var order = ids.filter { $0 != itemID }
        order.insert(itemID, at: min(max(0, index), order.count))
        try await expectSuccess(RawRequest(method: .put, path: RawRequest.path("rpc", "tasks", sessionID, "queue"),
                                           body: Self.json(.object(["item_ids": .array(order.map(JSONValue.string))]))))
    }

    public func sendQueuedNow(sessionID: String, itemID: String) async throws {
        try await expectSuccess(RawRequest(method: .post, path: RawRequest.path("rpc", "tasks", sessionID, "queue", itemID, "send")))
    }

    public func stop(sessionID: String) async throws {
        guard let run = try await activeRun(sessionID) else { return }
        try await expectSuccess(RawRequest(method: .post, path: RawRequest.path("rpc", "task-runs", run.id, "cancel")))
    }

    public func respond(sessionID: String, approvalID: String, response: ApprovalResponse) async throws {
        try await expectSuccess(RawRequest(method: .post, path: RawRequest.path("rpc", "approvals", approvalID, "respond"),
                                           body: Self.json(ConversationWire.respondBody(response))))
    }

    // MARK: Session

    private struct TaskResult: Decodable { let task: JSONValue }

    public func rename(sessionID: String, title: String) async throws {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ServiceError.invalid("A title is required.") }
        let response = try await expectSuccess(RawRequest(method: .patch, path: RawRequest.path("rpc", "tasks", sessionID, "title"),
                                                          body: Self.json(.object(["title": .string(trimmed)]))))
        if let result = try? JSONDecoder().decode(TaskResult.self, from: Self.successBody(response)) { applyTask(result.task) }
    }

    /// `POST /rpc/task-runs/:id/fork`: `workspace` only where there is a checkout to choose (fork-client.ts).
    public func continueFromRun(sessionID: String, runID: String) async throws -> SessionSummary {
        let projectID = locked { taskRows[sessionID]?.projectId }
        let isScratch = locked { projectRows.first { $0.id == projectID }?.isGeneral ?? false }
        let body = isScratch ? Data("{}".utf8) : Self.json(.object(["workspace": .string(ContinuationCheckout.sameCheckout.rawValue)]))
        let forked: TaskResult
        do {
            let response = try await expectSuccess(RawRequest(method: .post, path: RawRequest.path("rpc", "task-runs", runID, "fork"), body: body))
            forked = try JSONDecoder().decode(TaskResult.self, from: Self.successBody(response))
        } catch {
            throw ServiceError.refused("Could not continue in a new session")
        }
        applyTask(forked.task)
        guard let row = TaskRow(forked.task) else { throw ServiceError.refused("Could not continue in a new session") }
        await markViewed(sessionID: row.id)
        return row.summary(defaultAgent: locked { profileAgent })
    }

    public func abortConflict(sessionID: String) async throws {
        guard let run = try await activeRun(sessionID) else { throw ServiceError.notFound("Run") }
        try await expectSuccess(RawRequest(method: .post, path: RawRequest.path("rpc", "task-runs", run.id, "conflicts", "abort")))
        await conversations.existing(sessionID)?.loadBranchStatus(run.id)
    }

    // MARK: Images

    private struct ImageResult: Decodable {
        struct Image: Decodable {
            let id: String
            let filePath: String
            let originalName: String?
        }
        let image: Image
    }

    /// Uploads to the session's newest run (`/rpc/task-runs/:id/images/upload`), or globally before it has one.
    public func uploadImage(sessionID: String, data: Data, fileName: String, contentType: String) async throws -> ChroServices.UploadedImage {
        let run = try? await activeRun(sessionID)
        let path = run.map { RawRequest.path("rpc", "task-runs", $0.id, "images", "upload") } ?? "/rpc/images/upload"
        let response: RawResponse
        do {
            response = try await link().upload(path: path, fileName: fileName, contentType: contentType, data: data)
        } catch let error as APIError {
            throw ServiceError.unavailable(error.message)
        }
        guard response.isSuccess else {
            if case .text(_, _, let text) = response { throw ServiceError.invalid(text) }
            throw ServiceError.invalid("HTTP \(response.status)")
        }
        let image = try APIDecoder.make().decode(ImageResult.self, from: Self.successBody(response)).image
        return ChroServices.UploadedImage(id: image.id, name: image.originalName ?? fileName, path: image.filePath)
    }

    private struct ImageMetadata: Decodable {
        let exists: Bool
        let proxyUrl: String?
    }

    /// A prompt's image: `GET /rpc/images/metadata?path=` gives its proxy route (markdown-image-source.ts).
    public func image(sessionID: String, path: String) async throws -> Data {
        let metadata = try await json(ImageMetadata.self, RawRequest(path: "/rpc/images/metadata", query: ["path": path]))
        guard metadata.exists, let proxy = metadata.proxyUrl else { throw ServiceError.notFound("Image") }
        guard case .binary(let status, _, let data) = try await send(RawRequest(path: proxy)), (200..<300).contains(status) else {
            throw ServiceError.notFound("Image")
        }
        return data
    }
}
