import ChroAPI
import ChroDomain
import ChroLink
import Foundation

/// What every right-dock live service shares: the paired desktop's link
/// (through `LiveWorkspace`), the run a session's dock reads, the request and
/// error conventions of `/rpc`, the run diff stream and the repo-events
/// streams. Files, Source Control, Gallery, Skills, Settings and System hold
/// one of these.
final class PanelLiveCalls: @unchecked Sendable {
    let workspace: LiveWorkspace
    private let lock = NSLock()
    private var runCache: [String: CachedRun] = [:]

    /// The run a session's dock reads: its id and its worktree on the desktop.
    struct ResolvedRun: Equatable, Sendable {
        var id: String
        var worktreePath: String?
    }

    private struct CachedRun {
        var run: ResolvedRun
        /// The task row's `updated_at` when resolved; a new run moves it.
        var taskUpdatedAt: Date
    }

    /// How a non-2xx answer surfaces: the shared `ServiceError`s, or the git
    /// refusal Source Control turns into the desktop's sentence.
    enum Failure {
        case service
        case git

        func error(status: Int, text: String) -> any Error {
            switch self {
            case .git: return SourceControlError.git(text)
            case .service: return status == 400 ? ServiceError.invalid(text) : ServiceError.refused(text)
            }
        }
    }

    init(workspace: LiveWorkspace) { self.workspace = workspace }

    // MARK: Scope

    /// The run the dock of a session reads (task-run-selection.ts
    /// `selectTargetTaskRun`): the running one, else the newest. Cached until
    /// the session's task row changes.
    func run(sessionID: String) async throws -> ResolvedRun {
        let stamp = workspace.locked { workspace.taskRows[sessionID]?.updatedAt }
        if let stamp, let cached = lock.withLock({ runCache[sessionID] }), cached.taskUpdatedAt == stamp { return cached.run }
        let list = try await decode(RunList.self, try await body(.get, ["rpc", "tasks", sessionID, "runs"]))
        let runs = list.runs.sorted { ($0.createdAt.flatMap(RFC3339.parse) ?? .distantPast) > ($1.createdAt.flatMap(RFC3339.parse) ?? .distantPast) }
        guard let pick = runs.first(where: { $0.status == "running" }) ?? runs.first else { throw ServiceError.notFound("Run") }
        let resolved = ResolvedRun(id: pick.id, worktreePath: pick.containerRef)
        if let stamp { lock.withLock { runCache[sessionID] = CachedRun(run: resolved, taskUpdatedAt: stamp) } }
        return resolved
    }

    /// `/rpc/projects/:project_id` or `/rpc/task-runs/:id` as path segments.
    func base(_ scope: CheckoutScope) async throws -> [String] {
        switch scope {
        case .project(let id): return ["rpc", "projects", id]
        case .run(let sessionID): return ["rpc", "task-runs", try await run(sessionID: sessionID).id]
        }
    }

    // MARK: Requests

    /// One router call; a non-2xx answer throws as `failure` says, with the server's text.
    @discardableResult
    func send(_ method: RawRequest.Method, _ segments: [String], query: [String: String] = [:], body: Any? = nil,
              failure: Failure = .service) async throws -> RawResponse {
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys, .fragmentsAllowed]) }
        let response = try await workspace.send(RawRequest(method: method, path: RawRequest.path(segments), query: query, body: data))
        guard response.isSuccess else { throw failure.error(status: response.status, text: Self.errorText(response)) }
        return response
    }

    /// The JSON body of a 2xx answer.
    func body(_ method: RawRequest.Method, _ segments: [String], query: [String: String] = [:], body: Any? = nil,
              failure: Failure = .service) async throws -> Data {
        switch try await send(method, segments, query: query, body: body, failure: failure) {
        case .json(_, let data): return data
        case .text(_, _, let text): return Data(text.utf8)
        case .binary(_, _, let data): return data
        }
    }

    /// A file's bytes (`binary-file`), whichever shape the host answered in.
    func bytes(_ segments: [String], query: [String: String], failure: Failure = .service) async throws -> Data {
        switch try await send(.get, segments, query: query, failure: failure) {
        case .binary(_, _, let data), .json(_, let data): return data
        case .text(_, _, let text): return Data(text.utf8)
        }
    }

    func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw ServiceError.unavailable("Unexpected response from the desktop.")
        }
    }

    /// The text of an error answer, as the desktop shows it (`desktopFetch` throws the body text).
    static func errorText(_ response: RawResponse) -> String {
        switch response {
        case .text(let status, _, let text): return text.isEmpty ? "Request failed with status \(status)" : text
        case .json(let status, let body):
            let text = String(decoding: body, as: UTF8.self)
            return text.isEmpty || text == "null" ? "Request failed with status \(status)" : text
        case .binary(let status, _, _): return "Request failed with status \(status)"
        }
    }

    // MARK: Streams

    /// The run's diff (use-diff-stream.ts): `/rpc/task-runs/:id/diff` up to the
    /// empty patch that closes its first snapshot. `{"error"}` or an early end throws.
    func diffSnapshot(runID: String, statsOnly: Bool) async throws -> [FileChange] {
        let link = try await workspace.link()
        let params = try JSONSerialization.data(withJSONObject: ["id": runID, "stats_only": statsOnly], options: [.sortedKeys])
        // use-diff-stream.ts starts from `{diffs: {}, approvals: {}}`; entries arrive as `add /diffs/<path>`.
        let empty = JSONValue.object(["diffs": .object([:]), "approvals": .object([:])])
        var document = empty
        do {
            for try await event in await link.subscribe(stream: "/rpc/task-runs/:id/diff", params: params) {
                switch event {
                case .started:
                    document = empty
                case .message(let data):
                    switch try StreamMessage(data) {
                    case .patch(let operations) where operations.isEmpty:
                        return try Self.changes(in: document)
                    case .patch(let operations):
                        try JSONPatch.apply(operations, to: &document)
                    case .failure(let message):
                        throw ServiceError.unavailable(message)
                    case .finished, .other:
                        continue
                    }
                }
            }
        } catch let error as APIError {
            throw ServiceError.unavailable(error.message)
        }
        throw ServiceError.unavailable("The diff stream closed before its first snapshot.")
    }

    /// `{diffs: {path: {type: "DIFF", content}}}` as file changes, by path.
    static func changes(in document: JSONValue) throws -> [FileChange] {
        guard case .object(let root) = document, case .object(let diffs)? = root["diffs"] else { return [] }
        return try diffs.keys.sorted().compactMap { key in
            guard case .object(var entry)? = diffs[key] else { return nil }
            if case .string("DIFF")? = entry["type"], case .object(let content)? = entry["content"] { entry = content }
            let data = try JSONEncoder().encode(JSONValue.object(entry))
            return try JSONDecoder().decode(WireDiff.self, from: data).change
        }
    }

    /// Invalidations from `/streams/{task-runs/:id|projects/:project_id}/repo-events`
    /// (repo-events.ts): once at subscription and after every reconnect, then for
    /// each relevant notification, bursts collapsed over 300 ms.
    func invalidations(_ scope: CheckoutScope, channels: Set<String>) -> AsyncStream<Void> {
        // A signal ("reload"): pending ones collapse into one.
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task { [self] in
                let pending = PendingInvalidation(continuation: continuation)
                while !Task.isCancelled {
                    do {
                        let stream: String
                        let params: [String: String]
                        switch scope {
                        case .project(let id):
                            stream = "/streams/projects/:project_id/repo-events"
                            params = ["project_id": id]
                        case .run(let sessionID):
                            stream = "/streams/task-runs/:id/repo-events"
                            params = ["id": try await run(sessionID: sessionID).id]
                        }
                        let link = try await workspace.link()
                        let encoded = try JSONSerialization.data(withJSONObject: params, options: [.sortedKeys])
                        for try await event in await link.subscribe(stream: stream, params: encoded) {
                            switch event {
                            case .started:
                                continuation.yield()
                            case .message(let data):
                                if Self.isRelevant(data, channels: channels) { pending.schedule() }
                            }
                        }
                    } catch let error as LinkError where error == .stopped || error == .authFailed || error == .incompatibleAPI {
                        break
                    } catch {}
                    guard (try? await Task.sleep(for: LiveWorkspace.resubscribeDelay)) != nil else { break }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// `repoEventMatches`: a `repo_event` on a wanted channel, or a resync.
    static func isRelevant(_ data: Data, channels: Set<String>) -> Bool {
        guard case .other(let type, let payload)? = try? StreamMessage(data), type == "repo_event",
              case .object(let fields) = payload, case .string(let channel)? = fields["channel"] else { return false }
        return channel == "resync" || channels.contains(channel)
    }

    static let invalidateDebounce: Duration = .milliseconds(300)

    /// Collapses a burst of notifications into one yield after the debounce.
    private final class PendingInvalidation: @unchecked Sendable {
        private let lock = NSLock()
        private var scheduled = false
        private let continuation: AsyncStream<Void>.Continuation

        init(continuation: AsyncStream<Void>.Continuation) { self.continuation = continuation }

        func schedule() {
            let start = lock.withLock { () -> Bool in
                defer { scheduled = true }
                return !scheduled
            }
            guard start else { return }
            Task {
                try? await Task.sleep(for: PanelLiveCalls.invalidateDebounce)
                lock.withLock { scheduled = false }
                continuation.yield()
            }
        }
    }

    // MARK: Wire

    struct RunList: Decodable {
        struct Run: Decodable {
            let id: String
            let status: String
            let createdAt: String?
            let containerRef: String?

            enum CodingKeys: String, CodingKey {
                case id, status
                case createdAt = "created_at"
                case containerRef = "container_ref"
            }
        }

        let runs: [Run]
    }

    /// log-types `Diff`.
    struct WireDiff: Decodable {
        let change: FileChange

        enum CodingKeys: String, CodingKey {
            case change, kind
            case oldPath = "old_path", newPath = "new_path", oldContent = "old_content", newContent = "new_content"
            case contentOmitted = "content_omitted", additions, deletions, isBinary = "is_binary"
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let raw = try container.decodeIfPresent(String.self, forKey: .change) ?? container.decode(String.self, forKey: .kind)
            change = FileChange(
                kind: FileChange.Kind(rawValue: raw) ?? .modified,
                oldPath: try container.decodeIfPresent(String.self, forKey: .oldPath),
                newPath: try container.decodeIfPresent(String.self, forKey: .newPath),
                oldContent: try container.decodeIfPresent(String.self, forKey: .oldContent),
                newContent: try container.decodeIfPresent(String.self, forKey: .newContent),
                contentOmitted: try container.decodeIfPresent(Bool.self, forKey: .contentOmitted) ?? false,
                additions: try container.decodeIfPresent(Int.self, forKey: .additions),
                deletions: try container.decodeIfPresent(Int.self, forKey: .deletions),
                isBinary: try container.decodeIfPresent(Bool.self, forKey: .isBinary) ?? false
            )
        }
    }

}
