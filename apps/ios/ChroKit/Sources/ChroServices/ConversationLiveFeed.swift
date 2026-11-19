import ChroAPI
import ChroDomain
import ChroLink
import Foundation

/// What one feed holds (for tests and diagnostics).
struct FeedRetention: Equatable, Sendable {
    var isOpen: Bool
    /// Run logs held.
    var logs: Int
    /// Run log subscriptions running.
    var runFeeds: Int
    /// The stream documents and logs, as JSON bytes (measured when the feed closes).
    var bytes: Int
}

/// The conversations of a `LiveWorkspace`: one feed per session, running while
/// a screen reads it. A closed feed keeps its last state for the next open,
/// within an LRU bounded by `maxInactiveFeeds` and `inactiveByteBudget`; a feed
/// being read is never evicted.
final class LiveConversations: @unchecked Sendable {
    static let maxInactiveFeeds = 8
    static let inactiveByteBudget = 4 * 1024 * 1024

    private let lock = NSLock()
    private var feeds: [String: LiveConversationFeed] = [:]
    private var readers: [String: Int] = [:]
    /// Closed feeds, least recently closed first, with their measured bytes.
    private var inactive: [(id: String, bytes: Int)] = []

    /// The conversation for one reader; the feed runs while at least one reads it.
    func stream(_ sessionID: String, workspace: LiveWorkspace) -> AsyncStream<SessionConversation> {
        let feed = lock.withLock { () -> LiveConversationFeed in
            let feed = feeds[sessionID] ?? LiveConversationFeed(sessionID: sessionID, workspace: workspace)
            feeds[sessionID] = feed
            readers[sessionID, default: 0] += 1
            if readers[sessionID] == 1 {
                inactive.removeAll { $0.id == sessionID }
                feed.start()
            }
            return feed
        }
        let inner = feed.broadcast.stream()
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let relay = Task {
                for await value in inner { continuation.yield(value) }
                continuation.finish()
            }
            // Not under the runtime's lock of the ending reader: `release` takes `lock`
            // and publishes, which takes other tasks' runtime locks.
            continuation.onTermination = { [weak self] _ in
                relay.cancel()
                Task { self?.release(sessionID) }
            }
        }
    }

    private func release(_ sessionID: String) {
        lock.withLock {
            readers[sessionID, default: 1] -= 1
            guard readers[sessionID] == 0, let feed = feeds[sessionID] else { return }
            readers[sessionID] = nil
            inactive.append((sessionID, feed.stop()))
            var total = inactive.reduce(0) { $0 + $1.bytes }
            while !inactive.isEmpty, inactive.count > Self.maxInactiveFeeds || total > Self.inactiveByteBudget {
                let evicted = inactive.removeFirst()
                total -= evicted.bytes
                feeds[evicted.id] = nil
            }
        }
    }

    func existing(_ sessionID: String) -> LiveConversationFeed? { lock.withLock { feeds[sessionID] } }

    /// Every held feed.
    var retention: [String: FeedRetention] {
        let held = lock.withLock {
            feeds.map { id, feed in (id, feed, readers[id] != nil, inactive.first { $0.id == id }?.bytes ?? 0) }
        }
        return Dictionary(uniqueKeysWithValues: held.map { id, feed, isOpen, bytes in
            let counts = feed.counts
            return (id, FeedRetention(isOpen: isOpen, logs: counts.logs, runFeeds: counts.runFeeds, bytes: bytes))
        })
    }
}

/// One session's conversation over the link, from the streams the desktop's
/// session view reads: the runs, their task sessions (each turn's prompt),
/// the queue, each shown run's log (entries and approvals), and for the
/// selected run its branch status (refetched on repo events) and diff totals.
final class LiveConversationFeed: @unchecked Sendable {
    let sessionID: String
    private weak var workspace: LiveWorkspace?
    let broadcast: ServiceBroadcast<SessionConversation>

    private let lock = NSLock()
    /// Between `start` and `stop`: only then are run logs followed.
    private var running = false
    private var tasks: [Task<Void, Never>] = []
    private var runFeeds: [String: Task<Void, Never>] = [:]
    private var branchFeed: (runID: String, tasks: [Task<Void, Never>])?

    // Stream documents.
    private var runsDocument = JSONValue.object([:])
    /// `runsDocument`'s runs, oldest first, derived once per change of the document.
    private var runList: [ConversationWire.Run] = []
    private var runsReady = false
    /// The host's default runtime was asked for (it seeds a session without runs).
    private var fallbackSettled = false
    private var sessionsDocument = JSONValue.object([:])
    private var queueDocument = JSONValue.object([:])
    private var logs: [String: ConversationWire.RunLog] = [:]
    /// The run streaming live: its turn ends in the working sentinel (`ConversationWire.liveRun`).
    private var liveRunID: String?
    private var branchValue: JSONValue?
    private var diffFiles: [String: (Int, Int)] = [:]
    private var outgoing: [ConversationWire.ContextRef] = []
    private var incoming: [ConversationWire.ContextRef] = []
    private var refsRunCount = -1
    private var continuation: ContinuationOrigin?
    private var originLoaded = false
    private var fallbackRuntime: RuntimeChoice?
    private var models: [ModelOption] = LiveWorkspace.staticModels
    /// Counts derived conversations (see `publish`).
    private var snapshotRevision: UInt64 = 0
    /// How many finished runs are shown, newest first (three per page).
    private var historyLimit = ConversationWire.historyPage

    init(sessionID: String, workspace: LiveWorkspace) {
        self.sessionID = sessionID
        self.workspace = workspace
        broadcast = ServiceBroadcast(SessionConversation(sessionID: sessionID, isLoaded: false, runtime: RuntimeChoice(agent: .claudeCode), hasRun: false))
    }

    // MARK: Lifecycle (driven by `LiveConversations`)

    func start() {
        lock.withLock { running = true }
        let spawned = [
            follow(stream: "/streams/tasks/:task_id/runs", params: ["task_id": sessionID]) { feed, message in feed.applyRuns(message) },
            follow(stream: "/streams/tasks/:task_id/sessions", params: ["task_id": sessionID]) { feed, message in feed.applySessions(message) },
            follow(stream: "/streams/tasks/:task_id/queue", params: ["task_id": sessionID]) { feed, message in feed.applyQueue(message) },
            Task { [weak self] in await self?.loadFallbackRuntime() },
        ]
        lock.withLock { tasks = spawned }
    }

    /// Stops every stream, returns the history to its first page and keeps only
    /// that page's logs. Returns the bytes still held.
    func stop() -> Int {
        let (all, runs, branch) = lock.withLock { () -> ([Task<Void, Never>], [Task<Void, Never>], [Task<Void, Never>]) in
            defer {
                running = false
                tasks = []
                runFeeds = [:]
                branchFeed = nil
                refsRunCount = -1
                historyLimit = ConversationWire.historyPage
                let kept = Set(shownRuns(runList, limit: historyLimit).shown.map(\.id))
                logs = logs.filter { kept.contains($0.key) }
            }
            return (tasks, Array(runFeeds.values), branchFeed?.tasks ?? [])
        }
        (all + runs + branch).forEach { $0.cancel() }
        publish()
        return retainedBytes
    }

    var counts: (logs: Int, runFeeds: Int) { lock.withLock { (logs.count, runFeeds.count) } }

    /// The JSON size of the documents and logs held.
    private var retainedBytes: Int {
        let encoder = JSONEncoder()
        func size(_ value: JSONValue) -> Int { (try? encoder.encode(value).count) ?? 0 }
        return lock.withLock {
            [runsDocument, sessionsDocument, queueDocument].reduce(0) { $0 + size($1) }
                + logs.values.reduce(0) { total, log in
                    total + log.entries.values.reduce(0) { $0 + size($1) } + log.approvals.values.reduce(0) { $0 + size($1) }
                }
        }
    }

    // MARK: Following streams

    /// Keeps `stream` subscribed on the current link: a reconnection starts it
    /// over from the server's snapshot; an ended stream is subscribed again.
    private func follow(stream: String, params: [String: String], resubscribe: @escaping @Sendable (LiveConversationFeed) -> Bool = { _ in true },
                        onStart: (@Sendable (LiveConversationFeed) -> Void)? = nil,
                        onMessage: @escaping @Sendable (LiveConversationFeed, Data) -> Void) -> Task<Void, Never> {
        Task { [weak self] in
            let encoded = (try? JSONSerialization.data(withJSONObject: params, options: [.sortedKeys])) ?? Data("{}".utf8)
            while !Task.isCancelled {
                guard let workspace = self?.workspace, let link = try? await workspace.link() else {
                    guard (try? await Task.sleep(for: LiveWorkspace.resubscribeDelay)) != nil else { return }
                    continue
                }
                do {
                    for try await event in await link.subscribe(stream: stream, params: encoded) {
                        guard let self else { return }
                        switch event {
                        case .started: onStart?(self)
                        case .message(let data): onMessage(self, data)
                        }
                    }
                } catch let error as LinkError where error == .stopped || error == .authFailed || error == .incompatibleAPI {
                    return
                } catch {
                    Diagnostics.streams.error("\(stream, privacy: .public) ended: \(String(describing: error), privacy: .public)")
                }
                guard let self, resubscribe(self) else { return }
                guard (try? await Task.sleep(for: LiveWorkspace.resubscribeDelay)) != nil else { return }
            }
        }
    }

    private static func patch(_ data: Data) -> [JSONValue]? {
        do {
            guard case .patch(let operations) = try StreamMessage(data) else { return nil }
            return operations
        } catch {
            Diagnostics.streams.error("stream message unreadable (\(data.count) bytes): \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    /// Applies a stream's patch to one of its documents; a patch that does not apply is logged.
    private static func apply(_ operations: [JSONValue], to document: inout JSONValue, stream: String) {
        var patched = document
        do {
            try JSONPatch.apply(operations, to: &patched)
            document = patched
        } catch {
            Diagnostics.streams.error("\(stream, privacy: .public) patch not applied: \(String(describing: error), privacy: .public)")
        }
    }

    private func applyRuns(_ data: Data) {
        guard let operations = Self.patch(data) else { return }
        lock.withLock {
            Self.apply(operations, to: &runsDocument, stream: "/streams/tasks/:task_id/runs")
            runList = ConversationWire.runs(runsDocument)
            runsReady = true
        }
        followRuns()
        publish()
    }

    private func applySessions(_ data: Data) {
        guard let operations = Self.patch(data) else { return }
        lock.withLock { Self.apply(operations, to: &sessionsDocument, stream: "/streams/tasks/:task_id/sessions") }
        publish()
    }

    private func applyQueue(_ data: Data) {
        guard let operations = Self.patch(data) else { return }
        lock.withLock { Self.apply(operations, to: &queueDocument, stream: "/streams/tasks/:task_id/queue") }
        publish()
    }

    // MARK: Runs

    /// The runs shown: the newest finished ones within the history limit, and every active one.
    private func shownRuns(_ runs: [ConversationWire.Run], limit: Int) -> (shown: [ConversationWire.Run], hasEarlier: Bool) {
        let finished = runs.filter { !$0.isActive }
        let kept = Set(finished.suffix(limit).map(\.id))
        return (runs.filter { $0.isActive || kept.contains($0.id) }, finished.count > limit)
    }

    /// The selected run: the active one, else the newest (task-run-selection.ts).
    private static func selected(_ runs: [ConversationWire.Run]) -> ConversationWire.Run? {
        runs.last { $0.status == "running" } ?? runs.last { $0.isActive } ?? runs.last
    }

    /// Subscribes the logs of newly shown runs and releases those of runs that left
    /// the history window (their logs too), and follows the selected run's branch.
    private func followRuns() {
        let (runs, limit) = lock.withLock { (runList, historyLimit) }
        let shown = shownRuns(runs, limit: limit).shown
        let shownIDs = Set(shown.map(\.id))
        let released = lock.withLock { () -> [Task<Void, Never>] in
            let gone = runFeeds.keys.filter { !shownIDs.contains($0) }
            defer {
                for id in gone { runFeeds[id] = nil }
                logs = logs.filter { shownIDs.contains($0.key) }
            }
            return gone.compactMap { runFeeds[$0] }
        }
        released.forEach { $0.cancel() }
        for run in shown {
            let isNew = lock.withLock { () -> Bool in
                guard running, runFeeds[run.id] == nil else { return false }
                runFeeds[run.id] = Task {}
                return true
            }
            guard isNew else { continue }
            let task = follow(stream: "/streams/task-runs/:id/logs", params: ["id": run.id], resubscribe: { feed in !feed.lock.withLock { feed.logs[run.id]?.finished ?? false } },
                              onStart: { feed in feed.lock.withLock { feed.logs[run.id] = ConversationWire.RunLog() } }) { feed, data in
                feed.applyLog(run.id, data)
            }
            let kept = lock.withLock { () -> Bool in
                guard runFeeds[run.id] != nil else { return false }
                runFeeds[run.id] = task
                return true
            }
            if !kept { task.cancel() }
        }
        if let selected = Self.selected(runs) { followBranch(selected) }
        let refresh = lock.withLock { () -> Bool in
            defer { refsRunCount = runs.count }
            return refsRunCount != runs.count
        }
        if refresh { Task { [weak self] in await self?.loadReferences() } }
    }

    private func applyLog(_ runID: String, _ data: Data) {
        let applied = lock.withLock { () -> Bool in
            // A message already in flight when the run left the window is dropped with its log.
            guard runFeeds[runID] != nil else { return false }
            switch ConversationWire.LogMessage(data) {
            case .patch(let operations): logs[runID, default: ConversationWire.RunLog()].apply(operations)
            case .finished: logs[runID, default: ConversationWire.RunLog()].finished = true
            case .replayStarted: logs[runID] = ConversationWire.RunLog()
            case .failure(let error):
                Diagnostics.streams.error("log of run \(runID, privacy: .public) failed: \(error, privacy: .public)")
                return false
            case .ignored: return false
            }
            return true
        }
        if applied { publish() }
    }

    // MARK: Branch

    private func followBranch(_ run: ConversationWire.Run) {
        let previous = lock.withLock { () -> [Task<Void, Never>]? in
            guard branchFeed?.runID != run.id else { return nil }
            defer {
                branchFeed = (run.id, [])
                branchValue = nil
                diffFiles = [:]
            }
            return branchFeed?.tasks ?? []
        }
        guard let previous else { return }
        previous.forEach { $0.cancel() }
        let started = [
            Task { [weak self] in await self?.loadBranchStatus(run.id) },
            follow(stream: "/streams/task-runs/:id/repo-events", params: ["id": run.id]) { feed, _ in
                Task { await feed.loadBranchStatus(run.id) }
            },
            follow(stream: "/rpc/task-runs/:id/diff", params: ["id": run.id], onStart: { feed in feed.lock.withLock { feed.diffFiles = [:] } }) { feed, data in
                guard let operations = Self.patch(data) else { return }
                feed.lock.withLock { ConversationWire.applyDiff(operations, to: &feed.diffFiles) }
                feed.publish()
            },
        ]
        lock.withLock { if branchFeed?.runID == run.id { branchFeed?.tasks = started } else { started.forEach { $0.cancel() } } }
    }

    func loadBranchStatus(_ runID: String) async {
        guard let workspace, let value = try? await workspace.json(JSONValue.self, RawRequest(path: RawRequest.path("rpc", "task-runs", runID, "branch-status"))) else { return }
        lock.withLock { if branchFeed?.runID == runID { branchValue = value } }
        publish()
    }

    // MARK: References and origin

    private struct RefList: Decodable { let refs: [JSONValue] }

    private func loadReferences() async {
        guard let workspace else { return }
        async let out = try? workspace.json(RefList.self, RawRequest(path: RawRequest.path("rpc", "tasks", sessionID, "context-refs")))
        async let into = try? workspace.json(RefList.self, RawRequest(path: RawRequest.path("rpc", "tasks", sessionID, "referenced-by")))
        let (outgoingRefs, incomingRefs) = await (out, into)
        lock.withLock {
            if let outgoingRefs { outgoing = outgoingRefs.refs.compactMap(ConversationWire.ContextRef.init) }
            if let incomingRefs { incoming = incomingRefs.refs.compactMap(ConversationWire.ContextRef.init) }
        }
        publish()
        await loadOrigin()
    }

    /// The fork edge's source history (conversation-fork-origin.tsx).
    private func loadOrigin() async {
        guard let workspace else { return }
        let edge = lock.withLock { () -> ConversationWire.ContextRef? in
            guard !originLoaded else { return nil }
            return outgoing.first { $0.kind == "fork" && $0.targetTaskID != nil }
        }
        guard let edge, let source = edge.targetTaskID else { return }
        lock.withLock { originLoaded = true }
        let history: ContinuationOrigin.History
        if edge.mode == "native" {
            struct Runs: Decodable { let runs: [JSONValue] }
            let runs = ((try? await workspace.json(Runs.self, RawRequest(path: RawRequest.path("rpc", "tasks", source, "runs"))))?.runs ?? [])
                .compactMap(ConversationWire.Run.init).sorted { $0.createdAt < $1.createdAt }
            let inlined = ContinuationOrigin.inlinedRuns(ascending: runs.map(\.id), anchorRunID: edge.anchorRunID)
            var entries: [ConversationEntry] = []
            for runID in inlined {
                let log = await replay(runID, workspace: workspace)
                entries += ConversationWire.entries(run: runID, log: log, prompt: nil)
            }
            history = .native(entries.map { var copy = $0; copy.isInherited = true; return copy })
        } else {
            struct LastMessage: Decodable { let user: String?; let assistant: String? }
            let last = try? await workspace.json(LastMessage.self, RawRequest(path: RawRequest.path("rpc", "tasks", source, "last-message")))
            history = .digest(user: last?.user, assistant: last?.assistant)
        }
        lock.withLock { continuation = ContinuationOrigin(sourceSessionID: source, sourceTitle: edge.label, history: history) }
        publish()
    }

    /// A finished run's log, read to its end.
    private func replay(_ runID: String, workspace: LiveWorkspace) async -> ConversationWire.RunLog {
        var log = ConversationWire.RunLog()
        guard let link = try? await workspace.link() else { return log }
        let params = (try? JSONSerialization.data(withJSONObject: ["id": runID])) ?? Data("{}".utf8)
        do {
            for try await event in await link.subscribe(stream: "/streams/task-runs/:id/logs", params: params) {
                guard case .message(let data) = event else {
                    log = ConversationWire.RunLog()  // started (again): the history follows from the beginning
                    continue
                }
                switch ConversationWire.LogMessage(data) {
                case .patch(let operations): log.apply(operations)
                case .finished: return log
                default: continue
                }
            }
        } catch {}
        return log
    }

    private func loadFallbackRuntime() async {
        guard let workspace else { return }
        let catalogue = (try? await workspace.models()) ?? LiveWorkspace.staticModels
        let runtime = try? await workspace.defaultRuntime()
        lock.withLock {
            models = catalogue
            fallbackRuntime = runtime
            fallbackSettled = true
        }
        publish()
    }

    // MARK: History paging

    func loadEarlierHistory() {
        lock.withLock { historyLimit += ConversationWire.historyPage }
        followRuns()
        publish()
    }

    // MARK: Current facts for actions

    var runs: [ConversationWire.Run] { lock.withLock { runList } }

    // MARK: Assembly

    /// Derives the conversation under `lock` with a revision, so a slower publish
    /// of an earlier state never replaces a later one.
    func publish() {
        let (value, revision): (SessionConversation, UInt64) = lock.withLock {
            snapshotRevision += 1
            let runs = runList
            let (shown, hasEarlier) = shownRuns(runs, limit: historyLimit)
            let sessions = ConversationWire.sessions(sessionsDocument)
            liveRunID = ConversationWire.liveRun(runs: runs, logs: logs, current: liveRunID)
            var entries: [ConversationEntry] = []
            for run in shown {
                let prompt = sessions.first { $0.runID == run.id && !($0.prompt ?? "").isEmpty }
                entries += ConversationWire.entries(run: run.id, log: logs[run.id], prompt: prompt, isLive: run.id == liveRunID)
            }
            let selected = Self.selected(runs)
            let diff = diffFiles.values.reduce((additions: 0, deletions: 0)) { ($0.additions + $1.0, $0.deletions + $1.1) }
            let branch = branchValue.map { ConversationWire.branchStatus($0, runTarget: selected?.targetBranch, diff: diff) }
                ?? SessionBranchStatus(additions: diff.additions, deletions: diff.deletions, targetBranch: selected?.targetBranch)
            let runtime = ConversationWire.runtime(runs.last?.executorLabel, models: models) ?? fallbackRuntime ?? broadcast.value.runtime
            return (SessionConversation(
                sessionID: sessionID,
                entries: entries,
                continuation: continuation,
                // A session without runs runs with the host's default: loaded once that is known.
                isLoaded: runsReady && (!runs.isEmpty || fallbackSettled),
                hasEarlierHistory: hasEarlier,
                pendingApproval: selected.flatMap { ConversationWire.pendingApproval(logs[$0.id], runID: $0.id) },
                queue: ConversationWire.queue(queueDocument),
                references: ConversationWire.references(outgoing: outgoing, incoming: incoming, sessionID: sessionID),
                branchStatus: branch,
                usesWorktree: selected.map { $0.containerRef != nil } ?? true,
                runtime: runtime,
                hasRun: !runs.isEmpty
            ), snapshotRevision)
        }
        broadcast.publish(value, revision: revision)
    }
}
