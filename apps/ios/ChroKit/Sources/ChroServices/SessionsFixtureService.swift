import ChroDomain
import Foundation

/// In-memory services seeded with the HTML mock's captured workspace. The app
/// runs on these for simulator checks and screenshot comparison; each method
/// behaves like the desktop's for the same request.
public final class FixtureWorkspace: @unchecked Sendable {
    let now: @Sendable () -> Date
    let titleDelay: Duration
    /// Set, a sent turn is answered one step per interval and then ends
    /// (`-ChroReplyPace`); nil, it stays at work as the captured running sessions do.
    let replyPace: Duration?
    let sessionList: ServiceBroadcast<[SessionSummary]>
    let preferenceState: ServiceBroadcast<SessionListPreferences>
    let projectState: ServiceBroadcast<ProjectsState>
    let pairingState: ServiceBroadcast<PairingState>
    let lock = NSLock()
    var archived: [ArchivedSession] = []
    var knownProjects: [ProjectSummary]
    var installStatus: InstallStatus
    var defaultAgent: AgentKind
    var onboardingComplete: Bool
    var usedPairingCodes: Set<String> = []
    /// The conversations of the sessions (ConversationFixtureService.swift).
    let conversationState = FixtureConversations()

    public init(scenario: FixtureScenario = .standard, now: @escaping @Sendable () -> Date = { Date() }, titleDelay: Duration = .milliseconds(1500),
                replyPace: Duration? = nil) {
        let start = now()
        self.now = now
        self.titleDelay = titleDelay
        self.replyPace = replyPace
        let populated = scenario == .standard || scenario == .unpaired
        let sessions = populated ? MockCapture.sessions(now: start) : []
        sessionList = ServiceBroadcast(sessions)
        var viewed: [String: Date] = [:]
        for session in sessions where MockCapture.viewedIDs.contains(session.id) { viewed[session.id] = session.updatedAt.addingTimeInterval(1) }
        var pins: [String: Date] = [:]
        for id in MockCapture.pinnedIDs where sessions.contains(where: { $0.id == id }) { pins[id] = start.addingTimeInterval(-3_600) }
        preferenceState = ServiceBroadcast(SessionListPreferences(pins: pins, viewedAt: viewed))
        projectState = ServiceBroadcast(ProjectsState(
            openProjects: populated ? [MockCapture.inventory] : [],
            recents: populated ? [MockCapture.inventory] : [],
            scratchProjectIDs: [MockCapture.general.id]
        ))
        knownProjects = [MockCapture.general, MockCapture.inventory, MockCapture.pricing]
        installStatus = scenario == .bareHost ? MockCapture.bareHostInstall : MockCapture.mainHostInstall
        defaultAgent = .claudeCode
        onboardingComplete = populated
        pairingState = ServiceBroadcast(PairingState(
            hosts: scenario == .unpaired ? [] : [MockCapture.host],
            activeHostID: scenario == .unpaired ? nil : MockCapture.host.id,
            connection: scenario == .unpaired ? .connecting : .connected
        ))
    }

    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}

extension FixtureWorkspace: SessionsService {
    public func sessions() -> AsyncStream<[SessionSummary]> { sessionList.stream() }

    /// The fixture holds every session, so counts follow the list and there is never more to show.
    public func sessionCounts() -> AsyncStream<[String: SessionCounts]> {
        let lists = sessionList.stream()
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let follower = Task {
                for await list in lists { continuation.yield(self.counts(live: list)) }
                continuation.finish()
            }
            continuation.onTermination = { _ in follower.cancel() }
        }
    }

    private func counts(live: [SessionSummary]) -> [String: SessionCounts] {
        var counts: [String: SessionCounts] = [:]
        for session in live { counts[session.projectID, default: SessionCounts(live: 0, archived: 0)].live += 1 }
        for entry in locked({ archived }) { counts[entry.session.projectID, default: SessionCounts(live: 0, archived: 0)].archived += 1 }
        return counts
    }

    public func showMoreSessions(projectID: String) async throws {}

    public func searchSessions(matching query: String) async throws -> [SessionSummary] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let names = Dictionary(uniqueKeysWithValues: knownProjects.map { ($0.id, $0.name.lowercased()) })
        return sessionList.value.filter { session in
            (session.title ?? "").lowercased().contains(needle) || (names[session.projectID] ?? "").contains(needle)
        }
    }

    public func holdSession(sessionID: String) async {}

    public func archivedSessions(projectID: String, matching query: String, offset: Int) async throws -> ArchivedPage {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let matching = locked { archived }.filter {
            $0.session.projectID == projectID && (needle.isEmpty || ($0.session.title ?? "").lowercased().contains(needle))
        }
        return ArchivedPage(sessions: Array(matching.dropFirst(offset).prefix(ArchivedPage.size)), total: matching.count)
    }

    public func archive(sessionID: String) async throws {
        guard var session = sessionList.value.first(where: { $0.id == sessionID }) else { throw ServiceError.notFound("Session") }
        session.isRunning = false
        session.awaitingInput = false
        let entry = ArchivedSession(session: session, archivedAt: now())
        locked { archived.insert(entry, at: 0) }
        sessionList.update { $0.removeAll { $0.id == sessionID } }
    }

    public func restore(sessionID: String) async throws {
        let entry: ArchivedSession? = locked {
            guard let index = archived.firstIndex(where: { $0.id == sessionID }) else { return nil }
            return archived.remove(at: index)
        }
        guard let entry else { throw ServiceError.notFound("Archived session") }
        sessionList.update { list in
            list.append(entry.session)
            list.sort { $0.updatedAt > $1.updatedAt }
        }
    }

    public func startSession(_ request: NewSessionRequest) async throws -> SessionSummary {
        let prompt = request.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty || !request.references.isEmpty else { throw ServiceError.invalid("A prompt is required.") }
        let scratch = projectState.value.scratchProjectIDs.contains(request.projectID)
        let hex = String(UUID().uuidString.lowercased().prefix(4))
        let branch: String? = scratch ? nil : request.useWorktree ? "ch/\(hex)-\(Self.slugify(prompt))" : request.baseBranch
        let session = SessionSummary(
            id: "\(hex)\(UUID().uuidString.lowercased().dropFirst(4))", shortID: hex, projectID: request.projectID, title: nil,
            status: "in_progress", isRunning: true, agent: request.runtime.agent, model: request.runtime.model, branch: branch,
            targetBranch: scratch ? nil : request.baseBranch, updatedAt: now()
        )
        sessionList.update { $0.insert(session, at: 0) }
        conversationState.recordStart(of: session, request: request)
        // The server titles a session shortly after its first turn starts.
        let title = Self.title(from: prompt.isEmpty ? request.references.map(\.label).joined(separator: " ") : prompt)
        let delay = titleDelay
        Task { [sessionList] in
            try? await Task.sleep(for: delay)
            sessionList.update { list in
                if let index = list.firstIndex(where: { $0.id == session.id }) { list[index].title = title }
            }
        }
        return session
    }

    public func continueSession(sessionID: String, in checkout: ContinuationCheckout) async throws -> SessionSummary {
        guard let source = sessionList.value.first(where: { $0.id == sessionID }) else { throw ServiceError.notFound("Session") }
        guard !source.isRunning else { throw ServiceError.refused("Could not continue in a new session") }
        let scratch = projectState.value.scratchProjectIDs.contains(source.projectID)
        let hex = String(UUID().uuidString.lowercased().prefix(4))
        let branch: String? = scratch ? nil : checkout == .newWorktree ? "ch/\(hex)-\(Self.slugify(source.title ?? ""))" : source.branch
        let session = SessionSummary(
            id: "\(hex)\(UUID().uuidString.lowercased().dropFirst(4))", shortID: hex, projectID: source.projectID,
            title: Self.continuationTitle(source.title ?? ""), status: "pending", forkedFromTitle: source.title, agent: source.agent,
            branch: branch, updatedAt: now()
        )
        sessionList.update { $0.insert(session, at: 0) }
        conversationState.recordContinuation(of: source.id, as: session.id, checkout: checkout)
        await markViewed(sessionID: session.id)
        return session
    }

    /// "Title" becomes "Title (2)", "Title (2)" becomes "Title (3)".
    static func continuationTitle(_ title: String) -> String {
        if title.hasSuffix(")"), let open = title.range(of: " (", options: .backwards),
           let number = Int(title[open.upperBound..<title.index(before: title.endIndex)]) {
            return "\(title[..<open.lowerBound]) (\(number + 1))"
        }
        return "\(title) (2)"
    }

    /// The branch slug of a worktree session (lower-case, dashes, 28 characters).
    static func slugify(_ text: String) -> String {
        var slug = ""
        var pendingDash = false
        for scalar in text.lowercased().unicodeScalars {
            if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) {
                if pendingDash && !slug.isEmpty { slug.append("-") }
                slug.unicodeScalars.append(scalar)
                pendingDash = false
            } else {
                pendingDash = true
            }
        }
        var cut = String(slug.prefix(28))
        while cut.hasSuffix("-") { cut.removeLast() }
        return cut
    }

    /// The first sentence or line of the prompt, at most 60 characters.
    static func title(from prompt: String) -> String {
        let first = prompt.split(whereSeparator: { $0 == "." || $0 == "\n" }).first.map(String.init) ?? prompt
        return String(first.prefix(60))
    }
}

extension FixtureWorkspace: UIStateService {
    public func preferences() -> AsyncStream<SessionListPreferences> { preferenceState.stream() }

    public func togglePin(sessionID: String) async {
        let at = now()
        preferenceState.update { prefs in
            if prefs.pins[sessionID] != nil { prefs.pins[sessionID] = nil } else { prefs.pins[sessionID] = at }
        }
    }

    public func markViewed(sessionID: String) async {
        let at = now()
        preferenceState.update { $0.viewedAt[sessionID] = at }
    }

    public func setSortMode(_ mode: SessionSortMode) async { preferenceState.update { $0.sortMode = mode } }

    public func setCollapsedSections(_ sections: Set<SessionListSection>) async { preferenceState.update { $0.collapsedSections = sections } }
}

extension FixtureWorkspace: ComposerService {
    public func models() async throws -> [ModelOption] { MockCapture.models }

    public func defaultRuntime() async throws -> RuntimeChoice { RuntimeChoice(agent: locked { defaultAgent }) }

    public func branches(projectID: String) async throws -> [BranchOption] {
        var names = ["main"]
        for session in sessionList.value where session.projectID == projectID {
            if let branch = session.branch, !names.contains(branch) { names.append(branch) }
        }
        return names.map { BranchOption(name: $0, isCurrent: $0 == "main") }
    }

    public func skills(projectID: String) async throws -> [SkillSummary] { MockCapture.skills }

    public func files(projectID: String, query: String) async throws -> [String] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let files = projectID == MockCapture.inventory.id ? MockCapture.files : []
        return needle.isEmpty ? files : files.filter { $0.lowercased().contains(needle) }
    }
}
