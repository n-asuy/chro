import ChroAPI
import ChroDomain
import ChroLink
import Foundation

/// The services over the paired desktop's link: the same endpoints and
/// streams the desktop app uses, reached through the device dispatcher
/// (architecture doc §4.1). One instance serves all six service protocols, so
/// the session list, projects, UI state and pairing share one connection and
/// one view of the desktop.
///
/// While a host is active it keeps the session list subscribed: the host's
/// window of live sessions (`/streams/session-list`, architecture doc §27), or
/// every task (`/streams/tasks`) on a host without it. Every (re)connection
/// replaces the list with the server's snapshot and reloads the shared UI
/// state and the project list.
public final class LiveWorkspace: @unchecked Sendable {
    let hostStore: HostStore
    let tokens: any DeviceTokenStore
    let links: LiveHostLinks
    let pairingCoordinator: PairingCoordinator
    let now: @Sendable () -> Date

    let sessionList = ServiceBroadcast<[SessionSummary]>([])
    let countState = ServiceBroadcast<[String: SessionCounts]>([:])
    let preferenceState = ServiceBroadcast(SessionListPreferences(nestDelegations: false))
    let projectState = ServiceBroadcast(ProjectsState(openProjects: [], recents: [], scratchProjectIDs: []))
    let pairingState: ServiceBroadcast<PairingState>

    let lock = NSLock()
    /// The session list document (`{"tasks": {id: task}}`, plus `"counts"` on the
    /// windowed stream) and its decoded rows.
    var taskDocument = JSONValue.object([:])
    var taskRows: [String: TaskRow] = [:]
    var taskSnapshotReady = false
    var taskWaiters: [CheckedContinuation<Void, Never>] = []
    /// The current connection streams the host's window instead of every task.
    var listIsWindowed = false
    /// What the windowed stream holds; read again at every (re)subscription.
    var listWindow = SessionListWindow()
    /// The sort the current subscription asked for; another one restarts it.
    var subscribedSort: SessionSortMode?
    /// Sessions already asked for by id (the subscription's `include` or a lookup):
    /// one the host did not send is archived or gone, so it is not asked for again.
    var askedSessionIDs: Set<String> = []
    /// The latest search's rows, so opening a result holds it without asking again.
    var searchedRows: [String: JSONValue] = [:]
    /// Ends the current list subscription so the next one asks for the current window.
    var listRestart: AsyncStream<Void>.Continuation?
    /// `GET /rpc/ui-state`, the desktop's keys and values.
    var uiState: [String: JSONValue] = [:]
    /// `uiState` holds the active host's state (not the empty start).
    var uiStateLoaded = false
    /// `GET /rpc/projects`.
    var projectRows: [ProjectRow] = []
    /// The executor of `GET /rpc/executor/profile`, for sessions that never ran.
    var profileAgent: AgentKind = .claudeCode
    /// Counts snapshots derived under `lock` for the broadcasts above, so a slower
    /// publish of an earlier state never replaces a later one.
    var snapshotRevision: UInt64 = 0
    /// The open sessions' conversation feeds (ConversationLiveFeed.swift).
    let conversations = LiveConversations()
    private var feed: Task<Void, Never>?

    /// - Parameters:
    ///   - makeLink: builds the link to a paired desktop (tests pass an in-process connector).
    ///   - pairing: pairs new desktops (tests pass one with an in-process connector).
    public init(
        hosts: HostStore = HostStore(),
        tokens: any DeviceTokenStore = KeychainTokenStore(),
        defaults: UserDefaults = .standard,
        pairing: PairingCoordinator? = nil,
        now: @escaping @Sendable () -> Date = Date.init,
        makeLink: @escaping @Sendable (ChroLink.Host, String) -> ChroLink = { host, token in ChroLink(host: host, deviceToken: token) }
    ) {
        hostStore = hosts
        self.tokens = tokens
        self.now = now
        pairingCoordinator = pairing ?? PairingCoordinator(hosts: hosts, tokens: tokens, now: now)
        pairingState = ServiceBroadcast(PairingState(hosts: [], activeHostID: nil))
        let pairingState = self.pairingState
        let setting = ActiveHostSetting(defaults)
        links = LiveHostLinks(hosts: hosts, tokens: tokens, setting: setting, now: now, makeLink: makeLink, onState: { hostID, state in
            pairingState.update { pairing in
                guard pairing.activeHostID == hostID, let connection = HostConnection(state) else { return }
                pairing.connection = connection
                if state == .connected { pairing.hosts = hosts.hosts().map(PairedHost.init) }
            }
        })
        let active = LiveHostLinks.storedActiveHostID(setting, hosts: hosts)
        pairingState.update { $0 = PairingState(hosts: hosts.hosts().map(PairedHost.init), activeHostID: active) }
        feed = Task { [weak self, links] in
            await links.activate(active)
            for await link in await links.changes() {
                guard let self else { return }
                await self.follow(link)
            }
        }
    }

    deinit { feed?.cancel() }

    // MARK: Calls

    func link() async throws -> ChroLink { try await links.link() }

    /// One router call; link failures become `ServiceError.unavailable` with the link's message.
    func send(_ request: RawRequest) async throws -> RawResponse {
        do {
            return try await link().send(request)
        } catch let error as APIError {
            throw Self.serviceError(error, method: request.method)
        }
    }

    /// Codes after which a change may or may not have taken effect (architecture doc §4.1).
    static let unknownOutcomeCodes: Set<String> = ["deadline_exceeded", ErrorCode.unreachable.rawValue, ErrorCode.timeout.rawValue]

    /// A failed call as the screens see it: a change whose answer was lost has an unknown outcome.
    static func serviceError(_ error: APIError, method: RawRequest.Method) -> ServiceError {
        method != .get && unknownOutcomeCodes.contains(error.code.rawValue) ? .outcomeUnknown(error.message) : .unavailable(error.message)
    }

    /// A call that must answer 2xx JSON, decoded with the server's snake_case and RFC 3339 dates.
    func json<T: Decodable>(_ type: T.Type, _ request: RawRequest) async throws -> T {
        let body = try Self.successBody(try await send(request))
        do {
            return try APIDecoder.make().decode(type, from: body)
        } catch {
            throw ServiceError.unavailable("Unexpected response from the desktop (\(request.path)).")
        }
    }

    /// The JSON body of a 2xx answer; an error answer throws its text, as the desktop shows it.
    static func successBody(_ response: RawResponse) throws -> Data {
        switch response {
        case .json(let status, let body) where (200..<300).contains(status):
            return body
        case .text(let status, _, let text) where !(200..<300).contains(status):
            throw ServiceError.unavailable(text.isEmpty ? "HTTP \(status)" : text)
        default:
            throw ServiceError.unavailable("HTTP \(response.status)")
        }
    }

    /// A JSON request body (snake_case keys from `APIEncoder`).
    static func body<T: Encodable>(_ value: T) -> Data { try! APIEncoder.make().encode(value) }

    // MARK: Following the active host

    /// Delay before subscribing again when the server ended the task stream.
    static let resubscribeDelay: Duration = .seconds(2)

    /// The host serves the session list window (crates/server `SESSION_LIST_CAPABILITY`).
    static let sessionListCapability = "sessions.list-window.v1"
    static let windowedStream = "/streams/session-list"
    static let allTasksStream = "/streams/tasks"

    private enum FeedEnd { case linkGone, ended, restart }

    /// Runs the session feed on `link` until the link is replaced or stops.
    private func follow(_ link: ChroLink?) async {
        resetTasks()
        guard let link else { return }
        while !Task.isCancelled {
            let capabilities: Set<String>
            do {
                capabilities = try await link.capabilities(timeout: .seconds(3600))
            } catch {
                guard await link.state.isTerminal else { continue }
                return  // the link is gone; the next active link restarts the feed
            }
            let windowed = capabilities.contains(Self.sessionListCapability)
            locked { listIsWindowed = windowed }
            // The window follows the shared sort and pins: read them before asking for it.
            if windowed, !locked({ uiStateLoaded }) { await reloadUIState() }
            let subscription = windowed
                ? await link.subscribe(stream: Self.windowedStream, params: { [weak self] in self?.windowParams() ?? Data("{}".utf8) })
                : await link.subscribe(stream: Self.allTasksStream)
            // One per subscription: a stream whose reader was cancelled stays finished.
            let (restarts, restart) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
            locked { listRestart = restart }
            let end = await withTaskGroup(of: FeedEnd.self) { group in
                group.addTask { await self.consume(subscription, stream: windowed ? Self.windowedStream : Self.allTasksStream) }
                group.addTask {
                    for await _ in restarts { return .restart }
                    return .linkGone
                }
                let first = await group.next() ?? .linkGone
                group.cancelAll()
                return first
            }
            switch end {
            case .linkGone: return
            case .restart: continue
            case .ended:
                guard (try? await Task.sleep(for: Self.resubscribeDelay)) != nil, await link.state != .stopped else { return }
            }
        }
    }

    private func consume(_ subscription: LinkSubscription, stream: String) async -> FeedEnd {
        do {
            for try await event in subscription {
                switch event {
                case .started:
                    // The rows stay until the new snapshot replaces the collection:
                    // clearing them here blanked every open session while the stream restarted.
                    Task { await self.refreshShared() }
                case .message(let data):
                    switch Result(catching: { try StreamMessage(data) }) {
                    case .success(.patch(let operations)): applyTaskPatch(operations)
                    case .success: continue
                    case .failure(let error):
                        Diagnostics.streams.error("\(stream, privacy: .public) message unreadable (\(data.count) bytes): \(String(describing: error), privacy: .public)")
                    }
                }
            }
            return Task.isCancelled ? .restart : .ended
        } catch let error as LinkError where error == .stopped || error == .authFailed || error == .incompatibleAPI {
            return .linkGone
        } catch {
            if Task.isCancelled { return .restart }
            // The server ended the stream with an error: subscribe again.
            Diagnostics.streams.error("\(stream, privacy: .public) ended: \(String(describing: error), privacy: .public); subscribing again")
            return .ended
        }
    }

    /// The windowed subscription's params: the current sort, extended projects, pins and held sessions.
    func windowParams() -> Data {
        let params: [String: String] = locked {
            let preferences = SessionListPreferences(uiState: uiState)
            listWindow.sortMode = preferences.sortMode
            subscribedSort = listWindow.sortMode
            let params = listWindow.params(pinned: Array(preferences.pins.keys))
            askedSessionIDs.formUnion((params["include"] ?? "").split(separator: ",").map(String.init))
            return params
        }
        return (try? JSONEncoder().encode(params)) ?? Data("{}".utf8)
    }

    /// Follows the shared UI state: a new sort asks the host for another window,
    /// and pins outside the window are fetched.
    func followListPreferences() {
        let (windowed, restart, missingPins): (Bool, AsyncStream<Void>.Continuation?, [String]) = locked {
            let preferences = SessionListPreferences(uiState: uiState)
            let changed = subscribedSort.map { $0 != preferences.sortMode } ?? false
            let missing = taskSnapshotReady ? preferences.pins.keys.filter { taskRows[$0] == nil && !askedSessionIDs.contains($0) } : []
            return (listIsWindowed, changed ? listRestart : nil, missing)
        }
        guard windowed else { return }
        restart?.yield()
        if !missingPins.isEmpty { Task { await self.holdSessions(missingPins) } }
    }

    /// Reloads what the desktop keeps outside streams: UI state, projects and the default agent.
    func refreshShared() async {
        async let state: Void = reloadUIState()
        async let projects: Void = reloadProjects()
        async let profile: Void = reloadProfileAgent()
        _ = await (state, projects, profile)
    }

    private func reloadProfileAgent() async {
        guard let profile = try? await json(ProfileEnvelope.self, RawRequest(path: "/rpc/executor/profile")),
              let agent = AgentKind(rawValue: profile.profile.executor)
        else { return }
        locked { profileAgent = agent }
        publishSessions()
    }

    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    // MARK: Tasks

    private func resetTasks() {
        locked {
            taskDocument = .object([:])
            taskRows = [:]
            taskSnapshotReady = false
            listWindow = SessionListWindow()
            subscribedSort = nil
            askedSessionIDs = []
            searchedRows = [:]
            uiStateLoaded = false
        }
    }

    func applyTaskPatch(_ operations: [JSONValue]) {
        let waiters: [CheckedContinuation<Void, Never>] = locked {
            var document = taskDocument
            // The windowed stream removes sessions this phone may never have held.
            let applicable = operations.filter { !Self.removesAbsentMember($0, of: document) }
            do { try JSONPatch.apply(applicable, to: &document) } catch {
                Diagnostics.streams.error("/streams/tasks patch not applied: \(String(describing: error), privacy: .public)")
                return []
            }
            taskDocument = document
            guard case .object(let root) = document, case .object(let tasks)? = root["tasks"] else { return [] }
            // Decode only what the patch touched: a whole-collection replace, or single tasks.
            let touched = Self.touchedTaskIDs(applicable)
            if let touched {
                for id in touched { taskRows[id] = tasks[id].flatMap(TaskRow.init) }
            } else {
                taskRows = tasks.compactMapValues(TaskRow.init)
            }
            taskSnapshotReady = true
            defer { taskWaiters.removeAll() }
            return taskWaiters
        }
        for waiter in waiters { waiter.resume() }
        publishSessions()
    }

    /// The task ids under `/tasks/<id>` the operations touch; nil when one replaces the whole collection.
    /// Operations on the counts touch no task.
    static func touchedTaskIDs(_ operations: [JSONValue]) -> Set<String>? {
        var ids: Set<String> = []
        for operation in operations {
            guard case .object(let fields) = operation, case .string(let path)? = fields["path"],
                  let tokens = try? JSONPatch.pointer(path)
            else { return nil }
            if tokens.first == "counts" { continue }
            guard tokens.first == "tasks", tokens.count >= 2 else { return nil }
            ids.insert(tokens[1])
        }
        return ids
    }

    /// A `remove` of an object member the document does not have.
    static func removesAbsentMember(_ operation: JSONValue, of document: JSONValue) -> Bool {
        guard case .object(let fields) = operation, fields["op"] == .string("remove"), case .string(let path)? = fields["path"],
              let tokens = try? JSONPatch.pointer(path), let last = tokens.last
        else { return false }
        var node = document
        for token in tokens.dropLast() {
            guard case .object(let object) = node, let child = object[token] else { return true }
            node = child
        }
        guard case .object(let parent) = node else { return false }
        return parent[last] == nil
    }

    /// A task row the server returned from a write (or a lookup), applied ahead of its stream patch.
    /// The windowed list holds live sessions only, so an archived row leaves it.
    func applyTask(_ value: JSONValue) {
        guard let row = TaskRow(value) else { return }
        let escaped = row.id.replacingOccurrences(of: "~", with: "~0").replacingOccurrences(of: "/", with: "~1")
        let path = JSONValue.string("/tasks/\(escaped)")
        let leaves = row.isArchived && locked { listIsWindowed }
        applyTaskPatch([leaves ? .object(["op": .string("remove"), "path": path]) : .object(["op": .string("add"), "path": path, "value": value])])
    }

    func publishSessions() {
        let (rows, agent, hostCounts, revision) = locked { (Array(taskRows.values), profileAgent, Self.counts(in: taskDocument), nextSnapshotRevision()) }
        let list = rows.filter { !$0.isArchived }.map { $0.summary(defaultAgent: agent) }.sorted { $0.updatedAt > $1.updatedAt }
        sessionList.publish(list, revision: revision)
        // A host without the window streams every task, archived ones included: count those.
        countState.publish(hostCounts ?? Self.counts(of: rows), revision: revision)
    }

    /// The windowed stream's `/counts`; nil on the stream of every task.
    static func counts(in document: JSONValue) -> [String: SessionCounts]? {
        guard case .object(let root) = document, case .object(let counts)? = root["counts"] else { return nil }
        return counts.compactMapValues { value in
            guard case .object(let fields) = value, case .number(let live)? = fields["live"], case .number(let archived)? = fields["archived"] else { return nil }
            return SessionCounts(live: Int(live), archived: Int(archived))
        }
    }

    static func counts(of rows: [TaskRow]) -> [String: SessionCounts] {
        var counts: [String: SessionCounts] = [:]
        for row in rows {
            var entry = counts[row.projectId] ?? SessionCounts(live: 0, archived: 0)
            if row.isArchived { entry.archived += 1 } else { entry.live += 1 }
            counts[row.projectId] = entry
        }
        return counts
    }

    /// A revision for a snapshot derived now; call with `lock` held.
    func nextSnapshotRevision() -> UInt64 {
        snapshotRevision += 1
        return snapshotRevision
    }

    /// How long a call waits for the first task snapshot of a connection.
    static let snapshotDeadline: Duration = .seconds(30)

    /// The task rows once the first snapshot of the current connection arrived.
    func currentTasks() async throws -> [TaskRow] {
        _ = try await link()
        if !locked({ taskSnapshotReady }) {
            let arrived = await withTaskGroup(of: Bool.self) { group in
                group.addTask {
                    await withCheckedContinuation { continuation in
                        let resumeNow: Bool = self.locked {
                            if self.taskSnapshotReady { return true }
                            self.taskWaiters.append(continuation)
                            return false
                        }
                        if resumeNow { continuation.resume() }
                    }
                    return true
                }
                group.addTask {
                    try? await Task.sleep(for: Self.snapshotDeadline)
                    return false
                }
                let first = await group.next() ?? false
                group.cancelAll()
                if !first { self.releaseTaskWaiters() }
                return first
            }
            guard arrived else { throw ServiceError.unavailable(LinkError.timeout.errorDescription ?? "") }
        }
        return locked { Array(taskRows.values) }
    }

    private func releaseTaskWaiters() {
        let waiters: [CheckedContinuation<Void, Never>] = locked {
            defer { taskWaiters.removeAll() }
            return taskWaiters
        }
        for waiter in waiters { waiter.resume() }
    }

    func task(_ id: String) async throws -> TaskRow {
        guard let row = try await currentTasks().first(where: { $0.id == id }) else { throw ServiceError.notFound("Session") }
        return row
    }

    // MARK: Projects

    func reloadProjects() async {
        guard let list = try? await json(ProjectsEnvelope.self, RawRequest(path: "/rpc/projects")) else { return }
        locked { projectRows = list.projects }
        publishProjects()
    }

    func projectRow(_ id: String) async throws -> ProjectRow {
        if let row = locked({ projectRows.first { $0.id == id } }) { return row }
        await reloadProjects()
        guard let row = locked({ projectRows.first { $0.id == id } }) else { throw ServiceError.notFound("Project") }
        return row
    }
}

// MARK: Wire rows

/// One task as `/streams/tasks` and the `/rpc/tasks` writes send it (crates/db `TaskRecord`),
/// or as the session list window and its lookups send it (`SessionListItem`, the same keys without
/// the ones the phone does not read).
struct TaskRow: Decodable, Sendable, Equatable {
    let id: String
    let projectId: String
    let title: String
    let status: String
    let branch: String?
    let worktreeDeleted: Bool?
    let activeSessionId: String?
    let awaitingInput: Bool?
    let createdAt: Date?
    let updatedAt: Date
    let lastExecutor: String?
    let lastSummary: String?
    let forkedFromTitle: String?
    let delegatedFromId: String?
    let note: String?

    /// The desktop's archive is `status == "cancelled"` (use-archived-sessions.ts).
    static let archivedStatus = "cancelled"
    var isArchived: Bool { status == Self.archivedStatus }

    init?(_ value: JSONValue) {
        guard let data = try? JSONEncoder().encode(value), let row = try? APIDecoder.make().decode(TaskRow.self, from: data) else { return nil }
        self = row
    }

    func summary(defaultAgent: AgentKind) -> SessionSummary {
        SessionSummary(
            id: id,
            shortID: String(id.replacingOccurrences(of: "-", with: "").prefix(4)),
            projectID: projectId,
            title: title.isEmpty ? nil : title,
            status: status,
            isRunning: activeSessionId != nil,
            awaitingInput: awaitingInput ?? false,
            worktreeDeleted: worktreeDeleted ?? false,
            delegatedFromID: delegatedFromId,
            forkedFromTitle: forkedFromTitle,
            note: note,
            summary: lastSummary,
            agent: lastExecutor.flatMap(AgentKind.init(rawValue:)) ?? defaultAgent,
            branch: branch,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }
}

/// `GET /rpc/projects` (projects.rs `ProjectsEnvelope`, record fields flattened).
struct ProjectsEnvelope: Decodable, Sendable {
    let projects: [ProjectRow]
}

struct ProjectRow: Decodable, Sendable, Equatable {
    let id: String
    let slug: String?
    let name: String
    let gitRepoPath: String
    let badgeColor: String?
    let isGeneral: Bool

    var summary: ProjectSummary {
        ProjectSummary(id: id, name: name, path: gitRepoPath, isGitRepository: !isGeneral, badgeColor: badgeColor)
    }
}

/// `{project, is_general}` of the project writes.
struct ProjectEnvelope: Decodable, Sendable {
    struct Record: Decodable, Sendable {
        let id: String
        let slug: String?
        let name: String
        let gitRepoPath: String
        let badgeColor: String?
    }

    let project: Record
    let isGeneral: Bool

    var row: ProjectRow {
        ProjectRow(id: project.id, slug: project.slug, name: project.name, gitRepoPath: project.gitRepoPath, badgeColor: project.badgeColor, isGeneral: isGeneral)
    }
}

/// `GET /rpc/executor/profile` (config.rs).
struct ProfileEnvelope: Decodable, Sendable {
    struct Profile: Decodable, Sendable {
        let executor: String
        let model: String?
        let reasoningEffort: String?
        let speed: String?
    }

    let profile: Profile
}

extension PairedHost {
    init(_ record: HostRecord) {
        self.init(id: record.id, name: record.name, endpoint: record.endpoint.absoluteString, lastConnected: record.lastConnected)
    }
}
