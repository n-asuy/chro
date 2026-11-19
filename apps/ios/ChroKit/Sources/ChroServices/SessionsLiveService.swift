import ChroAPI
import ChroDomain
import ChroLink
import Foundation

extension LiveWorkspace: SessionsService {
    public func sessions() -> AsyncStream<[SessionSummary]> { sessionList.stream() }

    public func sessionCounts() -> AsyncStream<[String: SessionCounts]> { countState.stream() }

    /// `GET /rpc/session-list` (crates/server `routes/rpc/session_list.rs`).
    static let sessionListPath = "/rpc/session-list"

    private struct SessionPage: Decodable {
        let sessions: [JSONValue]
        let total: Int
    }

    private func sessionPage(_ query: [String: String]) async throws -> SessionPage {
        let body = try Self.successBody(try await send(RawRequest(path: Self.sessionListPath, query: query)))
        do {
            return try JSONDecoder().decode(SessionPage.self, from: body)
        } catch {
            throw ServiceError.unavailable("Unexpected response from the desktop (\(Self.sessionListPath)).")
        }
    }

    /// The next page of the project's list in the list's order; the window keeps
    /// it across reconnects. A host without the window already sent everything.
    public func showMoreSessions(projectID: String) async throws {
        let (windowed, page, sort) = locked { (listIsWindowed, listWindow.nextPage(of: projectID), listWindow.sortMode) }
        guard windowed else { return }
        let result = try await sessionPage([
            "project_id": projectID, "sort": sort.rawValue, "offset": String(page.offset), "limit": String(page.limit),
        ])
        for value in result.sessions { applyTask(value) }
        locked { listWindow.extend(projectID, through: page) }
    }

    /// Search runs on the host, which holds every session; a host without the
    /// window sent every task, so it runs on those.
    public func searchSessions(matching query: String) async throws -> [SessionSummary] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }
        let agent = locked { profileAgent }
        guard locked({ listIsWindowed }) else {
            let lowered = needle.lowercased()
            let names = locked { Dictionary(projectRows.map { ($0.id, $0.name.lowercased()) }, uniquingKeysWith: { first, _ in first }) }
            return try await currentTasks()
                .filter { !$0.isArchived && ($0.title.lowercased().contains(lowered) || (names[$0.projectId] ?? "").contains(lowered)) }
                .sorted { $0.updatedAt > $1.updatedAt }
                .map { $0.summary(defaultAgent: agent) }
        }
        let result = try await sessionPage(["q": needle, "limit": "200"])
        let rows = result.sessions.compactMap { value in TaskRow(value).map { (value, $0) } }
        locked { searchedRows = Dictionary(rows.map { ($0.1.id, $0.0) }, uniquingKeysWith: { first, _ in first }) }
        return rows.map { $0.1.summary(defaultAgent: agent) }
    }

    /// Holds a session the window does not (a search result, a pin made elsewhere)
    /// and keeps it across reconnects.
    public func holdSession(sessionID: String) async {
        await holdSessions([sessionID])
    }

    func holdSessions(_ ids: [String]) async {
        let (windowed, missing, searched): (Bool, [String], [JSONValue]) = locked {
            let missing = ids.filter { taskRows[$0] == nil }
            for id in missing { listWindow.hold(id) }
            askedSessionIDs.formUnion(missing)
            return (listIsWindowed, missing, missing.compactMap { searchedRows[$0] })
        }
        guard windowed, !missing.isEmpty else { return }
        for value in searched { applyTask(value) }
        let unknown = missing.filter { id in locked { taskRows[id] == nil } }
        guard !unknown.isEmpty, let result = try? await sessionPage(["ids": unknown.prefix(200).joined(separator: ","), "limit": "200"]) else { return }
        for value in result.sessions { applyTask(value) }
    }

    /// The project's archive popover, a page at a time: archived tasks, newest
    /// first, archived at their last update (projects-panel.tsx).
    public func archivedSessions(projectID: String, matching query: String, offset: Int) async throws -> ArchivedPage {
        let agent = locked { profileAgent }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        func entry(_ row: TaskRow) -> ArchivedSession { ArchivedSession(session: row.summary(defaultAgent: agent), archivedAt: row.updatedAt) }
        guard locked({ listIsWindowed }) else {
            let lowered = needle.lowercased()
            let matching = try await currentTasks()
                .filter { $0.isArchived && $0.projectId == projectID && (lowered.isEmpty || $0.title.lowercased().contains(lowered)) }
                .sorted { $0.updatedAt > $1.updatedAt }
            return ArchivedPage(sessions: matching.dropFirst(offset).prefix(ArchivedPage.size).map(entry), total: matching.count)
        }
        var query = ["project_id": projectID, "archived": "true", "offset": String(offset), "limit": String(ArchivedPage.size)]
        if !needle.isEmpty { query["q"] = needle }
        let result = try await sessionPage(query)
        return ArchivedPage(sessions: result.sessions.compactMap(TaskRow.init).map(entry), total: result.total)
    }

    /// archiveTask of use-archived-sessions.ts: cancel a live run (best effort), then set `cancelled`.
    public func archive(sessionID: String) async throws {
        let task = try await self.task(sessionID)
        if task.activeSessionId != nil {
            _ = try? await send(RawRequest(method: .post, path: RawRequest.path("rpc", "tasks", sessionID, "cancel")))
        }
        try await setStatus(sessionID, TaskRow.archivedStatus)
    }

    /// Restoring returns the task to its initial status.
    public func restore(sessionID: String) async throws {
        try await setStatus(sessionID, "pending")
    }

    private struct StatusUpdate: Encodable { let status: String }
    private struct TaskEnvelope: Decodable { let task: JSONValue }

    private func setStatus(_ id: String, _ status: String) async throws {
        let request = RawRequest(method: .patch, path: RawRequest.path("rpc", "tasks", id, "status"), body: Self.body(StatusUpdate(status: status)))
        let body = try Self.successBody(try await send(request))
        if let envelope = try? JSONDecoder().decode(TaskEnvelope.self, from: body) { applyTask(envelope.task) }
    }

    /// Creates the session (`POST /v1/sessions` without starting it), then
    /// starts its first turn with the composer's settings
    /// (`POST /rpc/tasks/:id/messages`), as the desktop's composer does in one
    /// step through an execution route the phone may not call.
    public func startSession(_ request: NewSessionRequest) async throws -> SessionSummary {
        let text = request.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !request.references.isEmpty else { throw ServiceError.invalid("A prompt is required.") }
        let link = try await self.link()
        let images = try await uploadImages(request.references, link: link)
        let skills = try await resolveSkills(request.references, projectID: request.projectID)
        let prompt = Self.prompt(text: text, references: request.references, skills: skills, images: images)

        let created: SessionStarted
        do {
            created = try await link.call(Routes.sessionCreate, body: NewSession(project: request.projectID, prompt: prompt, start: false))
        } catch let error as APIError {
            throw ServiceError.unavailable(error.message)
        }
        let sessionID = created.session.id.uuidString.lowercased()
        let message = TaskMessage(
            prompt: prompt,
            executorProfileId: try await executorProfile(request.runtime),
            imageIds: images.isEmpty ? nil : images.map(\.id),
            useWorktree: request.useWorktree,
            targetBranch: request.baseBranch,
            selectedSkillIds: skills.map(\.id),
            contextRefs: request.references.compactMap(ContextRef.init)
        )
        _ = try Self.successBody(try await send(RawRequest(method: .post, path: RawRequest.path("rpc", "tasks", sessionID, "messages"), body: Self.body(message))))
        return SessionSummary(
            id: sessionID,
            shortID: String(sessionID.replacingOccurrences(of: "-", with: "").prefix(4)),
            projectID: request.projectID,
            title: created.session.title.isEmpty ? nil : created.session.title,
            status: "in_progress",
            isRunning: true,
            agent: request.runtime.agent,
            model: request.runtime.model,
            branch: created.session.branch,
            targetBranch: request.baseBranch,
            createdAt: created.session.createdAt,
            updatedAt: created.session.updatedAt
        )
    }

    /// `POST /rpc/tasks/:id/fork`: `workspace` is sent only where there is a
    /// checkout to choose (not for General chats), as projects-panel.tsx does.
    public func continueSession(sessionID: String, in checkout: ContinuationCheckout) async throws -> SessionSummary {
        let source = try await task(sessionID)
        let isScratch = locked { projectRows.first { $0.id == source.projectId }?.isGeneral ?? false }
        let body = isScratch ? Data("{}".utf8) : Self.body(["workspace": checkout.rawValue])
        let forked: TaskEnvelope
        do {
            let response = try await send(RawRequest(method: .post, path: RawRequest.path("rpc", "tasks", sessionID, "fork"), body: body))
            forked = try JSONDecoder().decode(TaskEnvelope.self, from: Self.successBody(response))
        } catch {
            // en.ts forkFailed.
            throw ServiceError.refused("Could not continue in a new session")
        }
        applyTask(forked.task)
        guard let row = TaskRow(forked.task) else { throw ServiceError.refused("Could not continue in a new session") }
        await markViewed(sessionID: row.id)
        return row.summary(defaultAgent: locked { profileAgent })
    }

    // MARK: Composer payload

    struct UploadedImage: Equatable {
        let id: String
        let name: String
        let filePath: String
    }

    private struct ImageEnvelope: Decodable {
        struct Image: Decodable { let id: String; let filePath: String }
        let image: Image
    }

    /// Each photo goes to `POST /rpc/images/upload` (multipart field `image`) before the session starts.
    private func uploadImages(_ references: [ComposerReference], link: ChroLink) async throws -> [UploadedImage] {
        var uploaded: [UploadedImage] = []
        for reference in references where reference.kind == .image {
            guard let data = reference.imageData else { continue }
            let response: RawResponse
            do {
                response = try await link.upload(path: "/rpc/images/upload", fileName: reference.label, contentType: Self.imageContentType(reference.label), data: data)
            } catch let error as APIError {
                throw ServiceError.unavailable(error.message)
            }
            let envelope = try APIDecoder.make().decode(ImageEnvelope.self, from: Self.successBody(response))
            uploaded.append(UploadedImage(id: envelope.image.id, name: reference.label, filePath: envelope.image.filePath))
        }
        return uploaded
    }

    static func imageContentType(_ fileName: String) -> String {
        switch fileName.split(separator: ".").last?.lowercased() {
        case "png": "image/png"
        case "gif": "image/gif"
        case "webp": "image/webp"
        case "heic": "image/heic"
        default: "image/jpeg"
        }
    }

    struct ResolvedSkill: Equatable {
        let id: String
        let name: String
    }

    /// Skill pills carry the skill's name; the server's id comes from `GET /rpc/skills` for the project.
    private func resolveSkills(_ references: [ComposerReference], projectID: String) async throws -> [ResolvedSkill] {
        let names = references.filter { $0.kind == .skill }.map(\.target)
        guard !names.isEmpty else { return [] }
        let available = try await skillRows(projectID: projectID)
        return names.compactMap { name in available.first { $0.name == name }.map { ResolvedSkill(id: $0.id, name: $0.name) } }
    }

    /// buildPromptPayload of single-agent-session.tsx: `<context>`, `<skills_context>`,
    /// one `![name](path)` per image, then the text, joined by newlines.
    static func prompt(text: String, references: [ComposerReference], skills: [ResolvedSkill], images: [UploadedImage]) -> String {
        var parts: [String] = []
        let context = references.compactMap { reference -> String? in
            switch reference.kind {
            case .file: return "<file path=\"\(xmlAttribute(reference.target))\" />"
            case .directory: return "<directory path=\"\(xmlAttribute(reference.target))\" />"
            case .session:
                return [
                    "<past_session task_id=\"\(xmlAttribute(reference.target))\">",
                    "Referenced session. A summary is injected at execution time; run `chro session read \(reference.target) --format markdown` for the full transcript.",
                    "</past_session>",
                ].joined(separator: "\n")
            case .skill, .image: return nil
            }
        }
        if !context.isEmpty { parts.append("<context>\n\(context.joined(separator: "\n"))\n</context>") }
        if !skills.isEmpty {
            let tags = skills.map { "<skill id=\"\(xmlAttribute($0.id))\" name=\"\(xmlAttribute($0.name))\" />" }
            parts.append("<skills_context>\n\(tags.joined(separator: "\n"))\n</skills_context>")
        }
        if !images.isEmpty { parts.append(images.map { "![\($0.name)](\($0.filePath))" }.joined(separator: "\n")) }
        if !text.isEmpty { parts.append(text) }
        return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func xmlAttribute(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }

    /// `executor_profile_id`: the runtime's executor and, when chosen, the model's value, effort and speed.
    func executorProfile(_ runtime: RuntimeChoice) async throws -> ExecutorProfile {
        var modelValue: String?
        if let label = runtime.model {
            let catalogue = (try? await models()) ?? Self.staticModels
            modelValue = catalogue.first { $0.label == label && $0.agent == runtime.agent }?.value ?? label
        }
        return ExecutorProfile(executor: runtime.agent.rawValue, model: modelValue, reasoningEffort: runtime.effort?.rawValue, speed: runtime.speed?.rawValue)
    }
}

/// `POST /rpc/tasks/:id/messages` (task_runs.rs `SendTaskMessageRequest`).
struct TaskMessage: Encodable {
    let prompt: String
    var mode = "auto"
    let executorProfileId: ExecutorProfile
    let imageIds: [String]?
    let useWorktree: Bool
    let targetBranch: String?
    let selectedSkillIds: [String]
    let contextRefs: [ContextRef]

    init(prompt: String, executorProfileId: ExecutorProfile, imageIds: [String]?, useWorktree: Bool, targetBranch: String?,
         selectedSkillIds: [String], contextRefs: [ContextRef]) {
        self.prompt = prompt
        self.executorProfileId = executorProfileId
        self.imageIds = imageIds
        self.useWorktree = useWorktree
        self.targetBranch = targetBranch
        self.selectedSkillIds = selectedSkillIds
        self.contextRefs = contextRefs
    }
}

/// executors `ExecutorProfileId`; absent fields are omitted.
struct ExecutorProfile: Encodable, Equatable {
    let executor: String
    let model: String?
    let reasoningEffort: String?
    let speed: String?
}

/// contextEntriesToRefs of session/types/context.ts.
struct ContextRef: Encodable, Equatable {
    let kind: String
    let path: String?
    let taskId: String?
    let mode: String

    init?(_ reference: ComposerReference) {
        switch reference.kind {
        case .file, .directory:
            kind = reference.kind.rawValue
            path = reference.target
            taskId = nil
            mode = "link"
        case .session:
            kind = "session"
            path = nil
            taskId = reference.target
            mode = "transcript"
        case .skill, .image:
            return nil
        }
    }
}
