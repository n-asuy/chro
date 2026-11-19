import ChroAPI
import Foundation
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// A desktop's chro-server as the phone reaches it: the router behind the
/// device dispatcher (the `/rpc` and `/v1` routes the live services use, with
/// the server's JSON shapes), `/streams/tasks` with a snapshot and live
/// patches, the session list window (`/streams/session-list` and
/// `GET /rpc/session-list`, when `servesSessionList`), and the UI state. Every connection gets a fresh `FakeResponder`
/// that shares this state, as connections to one server do.
final class FakeDesktop: @unchecked Sendable {
    static let hostSecret = LinkHarness.hostSecret
    static let endpoint = LinkHarness.endpoint
    static let token = String(repeating: "cd", count: 24)
    static let createdAt = "2026-11-14T09:00:00.000Z"

    let tokens = FakeTokenBook([FakeDesktop.token, FakeResponder.ticket])
    let clock = ManualClock()
    private let lock = NSLock()
    private var connector: FakeConnector!

    // Server state.
    var uiState: [String: Any] = [:]
    var projects: [[String: Any]] = []
    var tasks: [String: [String: Any]] = [:]
    var profile: [String: Any] = ["executor": "CLAUDE_CODE"]
    var piModels: [[String: Any]] = []
    var branches: [[String: Any]] = []
    var skills: [[String: Any]] = []
    var searchResults: [[String: Any]] = []
    var directories: [String: [String: Any]] = [:]
    var installStatus: [String: Any] = [:]
    /// New `/streams/tasks` subscriptions get no snapshot (a host still building it).
    var holdsTaskSnapshot = false
    /// The host advertises and serves the session list window (architecture doc §27).
    var servesSessionList = false
    /// The other streams' snapshots (`streamKey`), sent to each new subscription.
    var streamSnapshots: [String: [String]] = [:]
    /// Fixed answers by `"METHOD path"`, for further routes or in place of a built-in one.
    var replies: [String: FakeResponder.HTTPReply] = [:]
    /// Routes answered with a plain-text error instead (path → (status, text)).
    var failures: [String: (Int, String)] = [:]
    /// Routes the device dispatcher answers with an RPC error (`"METHOD path"` → code, message),
    /// as it does for `deadline_exceeded`.
    var rpcErrors: [String: (code: String, message: String)] = [:]
    private var log: [FakeResponder.HTTPRequest] = []
    private var createdCount = 0

    init() {
        // Weak: a link the test let go of may still be reconnecting after the desktop is gone.
        connector = FakeConnector { [weak self] _ in self.map { .accept($0.makeResponder()) } ?? .refuse }
    }

    func edit(_ change: (FakeDesktop) -> Void) { lock.withLock { change(self) } }

    var requests: [FakeResponder.HTTPRequest] { lock.withLock { log } }
    func requests(_ method: String, _ path: String) -> [FakeResponder.HTTPRequest] { requests.filter { $0.method == method && $0.path == path } }
    var responders: [FakeResponder] { connector.responders }
    var violations: [String] { responders.flatMap(\.violations) }

    /// A phone talking to this desktop.
    struct Phone: @unchecked Sendable {
        let workspace: LiveWorkspace
        let hosts: HostStore
        let tokens: MemoryTokenStore
        let defaults: UserDefaults
    }

    /// A `LiveWorkspace` already paired with this desktop and active (or not paired at all).
    func phone(paired: Bool = true, now: @escaping @Sendable () -> Date = Date.init) throws -> Phone {
        let defaults = UserDefaults(suiteName: "chro.live.\(UUID().uuidString)")!
        let hosts = HostStore(defaults: defaults)
        let store = MemoryTokenStore()
        if paired {
            let record = HostRecord(id: "host-1", name: "Host 1", endpoint: Self.endpoint, publicKey: LinkHarness.hostPublic, lastConnected: nil, machineName: nil)
            try hosts.upsert(record)
            try store.setToken(Self.token, forHost: record.id)
            defaults.set(record.id, forKey: ActiveHostSetting.key)
        }
        let connector = self.connector!
        let clock = self.clock
        let pairing = PairingCoordinator(hosts: hosts, tokens: store, connector: connector, clock: clock, random: CountingRandom(), now: now)
        let workspace = LiveWorkspace(hosts: hosts, tokens: store, defaults: defaults, pairing: pairing, now: now) { host, token in
            ChroLink(host: host, deviceToken: token, connector: connector, clock: clock, random: CountingRandom())
        }
        return Phone(workspace: workspace, hosts: hosts, tokens: store, defaults: defaults)
    }

    // MARK: Tasks

    static func task(_ id: String, project: String, title: String = "", status: String = "completed", updatedAt: String = createdAt,
                     active: String? = nil, executor: String? = "CLAUDE_CODE", branch: String? = nil) -> [String: Any] {
        [
            "id": id, "slug": NSNull(), "project_id": project, "parent_task_id": NSNull(), "title": title, "description": NSNull(),
            "status": status, "due_at": NSNull(), "branch": branch ?? NSNull(), "worktree_path": NSNull(), "worktree_deleted": false,
            "active_session_id": active ?? NSNull(), "awaiting_input": false, "created_at": createdAt, "updated_at": updatedAt,
            "sort_order": 0, "last_executor": executor ?? NSNull(), "last_summary": NSNull(), "title_pinned": false,
            "forked_from_title": NSNull(), "delegated_from_title": NSNull(), "delegated_from_id": NSNull(), "home_dir": NSNull(), "note": NSNull(),
        ]
    }

    static func project(_ id: String, name: String, path: String, general: Bool = false, badge: String? = nil) -> [String: Any] {
        ["id": id, "slug": NSNull(), "name": name, "git_repo_path": path, "setup_script": NSNull(), "dev_script": NSNull(),
         "cleanup_script": NSNull(), "copy_files": NSNull(), "badge_color": badge ?? NSNull(), "created_at": createdAt,
         "updated_at": createdAt, "is_general": general]
    }

    /// Sends one task patch to every `/streams/tasks` subscriber, as the event hook does.
    func publish(_ operation: [String: Any]) async throws {
        try await publish(message: Self.text(["type": "json_patch", "payload": [operation]]))
    }

    /// Publishes after the current reply, as the server's database hook does for a route's write.
    private func announce(_ operation: [String: Any]) {
        let message = Self.text(["type": "json_patch", "payload": [operation]])
        Task { try await self.publish(message: message) }
    }

    private func publish(message: String) async throws {
        let window = windowMessage(forTasksMessage: message)
        for responder in responders {
            for subscription in responder.subscriptions {
                switch subscription.stream {
                case "/streams/tasks": try await responder.push(message, to: subscription.subscriptionId)
                case Self.sessionListStream: if let window { try await responder.push(window, to: subscription.subscriptionId) }
                default: continue
                }
            }
        }
    }

    // MARK: Session list window (crates/events session_list.rs)

    static let sessionListStream = "/streams/session-list"
    static let sessionListCapabilities = [FakeResponder.ticketExchangeCapability, "stream.message-parts.v1", "sessions.list-window.v1"]
    /// Keys `SessionListItem` leaves out of a task record.
    static let unlistedKeys: Set<String> = ["slug", "parent_task_id", "description", "due_at", "worktree_path", "created_at", "sort_order",
                                            "title_pinned", "delegated_from_title", "home_dir"]

    static func item(_ task: [String: Any]) -> [String: Any] { task.filter { !unlistedKeys.contains($0.key) } }

    static func isArchived(_ task: [String: Any]) -> Bool { task["status"] as? String == "cancelled" }

    /// Every project's live and archived counts. Call with `lock` held.
    private func counts() -> [String: [String: Int]] {
        var counts: [String: [String: Int]] = [:]
        for task in tasks.values {
            let project = task["project_id"] as! String
            counts[project, default: ["live": 0, "archived": 0]][Self.isArchived(task) ? "archived" : "live"]! += 1
        }
        return counts
    }

    /// The window of `params`: newest rows per project (by recency only), running and named sessions.
    private func windowSnapshot(_ params: [String: String]) -> String {
        let (tasks, counts) = lock.withLock { (self.tasks, self.counts()) }
        let limit = Int(params["limit"] ?? "10") ?? 10
        var limits: [String: Int] = [:]
        for entry in (params["project_limits"] ?? "").split(separator: ",") {
            let parts = entry.split(separator: ":")
            limits[String(parts[0])] = Int(parts[1])
        }
        let include = Set((params["include"] ?? "").split(separator: ",").map(String.init))
        let live = tasks.values.filter { !Self.isArchived($0) }.sorted { ($0["updated_at"] as! String) > ($1["updated_at"] as! String) }
        var taken: [String: Int] = [:]
        var window: [String: Any] = [:]
        for task in live {
            let id = task["id"] as! String, project = task["project_id"] as! String
            let position = taken[project, default: 0]
            taken[project] = position + 1
            if position < max(limit, limits[project] ?? 0) || !(task["active_session_id"] is NSNull) || include.contains(id) {
                window[id] = Self.item(task)
            }
        }
        return Self.text(["type": "json_patch", "payload": [
            ["op": "add", "path": "/tasks", "value": window],
            ["op": "add", "path": "/counts", "value": counts],
        ]])
    }

    /// The window stream's message for a `/streams/tasks` message, as the server maps the hub's task changes.
    private func windowMessage(forTasksMessage message: String) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
              let operations = object["payload"] as? [[String: Any]], let operation = operations.first,
              let path = operation["path"] as? String, path.hasPrefix("/tasks/")
        else { return nil }
        var mapped: [[String: Any]]
        if let value = operation["value"] as? [String: Any], operation["op"] as? String != "remove" {
            mapped = [Self.isArchived(value) ? ["op": "remove", "path": path] : ["op": "add", "path": path, "value": Self.item(value)]]
        } else {
            mapped = [["op": "remove", "path": path]]
        }
        for (project, counts) in lock.withLock({ self.counts() }) {
            mapped.append(["op": "add", "path": "/counts/\(project)", "value": counts])
        }
        return Self.text(["type": "json_patch", "payload": mapped])
    }

    /// `GET /rpc/session-list`. Call with `lock` held.
    private func sessionPage(_ query: [String: String]) -> [String: Any] {
        let archived = query["archived"] == "true"
        let needle = query["q"]?.lowercased()
        let ids = query["ids"].map { Set($0.split(separator: ",").map(String.init)) }
        let names = Dictionary(uniqueKeysWithValues: projects.map { ($0["id"] as! String, ($0["name"] as! String).lowercased()) })
        var matching = tasks.values.filter { task in
            Self.isArchived(task) == archived
                && (query["project_id"].map { $0 == task["project_id"] as? String } ?? true)
                && (ids.map { $0.contains(task["id"] as! String) } ?? true)
                && (needle.map { needle in
                    (task["title"] as! String).lowercased().contains(needle) || (names[task["project_id"] as! String] ?? "").contains(needle)
                } ?? true)
        }
        matching.sort { ($0["updated_at"] as! String, $1["id"] as! String) > ($1["updated_at"] as! String, $0["id"] as! String) }
        let offset = Int(query["offset"] ?? "0") ?? 0, limit = Int(query["limit"] ?? "50") ?? 50
        return ["sessions": matching.dropFirst(offset).prefix(limit).map(Self.item), "total": matching.count]
    }

    func upsertTask(_ task: [String: Any]) async throws {
        let id = task["id"] as! String
        let existed = lock.withLock { () -> Bool in
            defer { tasks[id] = task }
            return tasks[id] != nil
        }
        try await publish(["op": existed ? "replace" : "add", "path": "/tasks/\(id)", "value": task])
    }

    func removeTask(_ id: String) async throws {
        _ = lock.withLock { tasks.removeValue(forKey: id) }
        try await publish(["op": "remove", "path": "/tasks/\(id)"])
    }

    // MARK: Serving

    private func makeResponder() -> FakeResponder {
        FakeResponder(
            secretKey: Self.hostSecret,
            tokens: tokens,
            handler: { [weak self] request in
                guard request.method == "request", let self,
                      let method = request.paramsObject["method"] as? String, let path = request.paramsObject["path"] as? String,
                      let failure = self.lock.withLock({ self.rpcErrors["\(method) \(path)"] })
                else { return .standard }
                return .error(code: failure.code, message: failure.message)
            },
            routes: { [weak self] http in self?.route(http) ?? .silence },
            snapshot: { [weak self] subscription in
                guard let self else { return [] }
                if subscription.stream == Self.sessionListStream { return [self.windowSnapshot(subscription.params)] }
                guard subscription.stream == "/streams/tasks" else {
                    return self.lock.withLock { self.streamSnapshots[Self.streamKey(subscription.stream, subscription.params)] ?? [] }
                }
                let (tasks, held) = self.lock.withLock { (self.tasks, self.holdsTaskSnapshot) }
                if held { return [] }
                return [Self.text(["type": "json_patch", "payload": [["op": "replace", "path": "/tasks", "value": tasks]]])]
            },
            capabilities: lock.withLock { servesSessionList } ? Self.sessionListCapabilities : [FakeResponder.ticketExchangeCapability]
        )
    }

    /// A stream subscription's key: its template and its id parameter.
    static func streamKey(_ stream: String, _ params: [String: String]) -> String {
        "\(stream)|\(params["task_id"] ?? params["id"] ?? "")"
    }

    static func streamKey(_ stream: String, id: String) -> String { "\(stream)|\(id)" }

    /// Sends one message to the subscribers of `stream` for `id`.
    func push(_ stream: String, id: String, _ message: Any) async throws {
        let text = Self.text(message)
        for responder in responders {
            for subscription in responder.subscriptions where Self.streamKey(subscription.stream, subscription.params) == Self.streamKey(stream, id: id) {
                try await responder.push(text, to: subscription.subscriptionId)
            }
        }
    }

    static func text(_ value: Any) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
    }

    private func ok(_ value: Any) -> FakeResponder.HTTPReply { .json(status: 200, Self.text(value)) }

    private func route(_ http: FakeResponder.HTTPRequest) -> FakeResponder.HTTPReply {
        lock.lock()
        defer { lock.unlock() }
        log.append(http)
        if let (status, text) = failures[http.path] { return .text(status: status, contentType: "text/plain; charset=utf-8", text) }
        // A fixed answer overrides the built-in route of the same request.
        if let reply = replies["\(http.method) \(http.path)"] { return reply }
        let body = http.bodyObject as? [String: Any] ?? [:]
        let route = Route(method: http.method, path: http.path)
        switch route {
        case let r where r.matches("GET", "/rpc/session-list") && servesSessionList:
            return ok(sessionPage(http.query))
        case let r where r.matches("GET", "/rpc/ui-state"):
            return ok(["ui_state": uiState])
        case let r where r.matches("PUT", "/rpc/ui-state"):
            for (key, value) in body {
                if value is NSNull { uiState.removeValue(forKey: key) } else { uiState[key] = value }
            }
            return ok(["ui_state": uiState])
        case let r where r.matches("GET", "/rpc/projects"):
            return ok(["projects": projects])
        case let r where r.matches("POST", "/rpc/projects/ensure"):
            let path = body["git_repo_path"] as? String ?? ""
            if let existing = projects.first(where: { $0["git_repo_path"] as? String == path }) {
                return ok(["project": existing, "is_general": existing["is_general"] ?? false])
            }
            let created = Self.project("p-\(projects.count + 1)", name: String(path.split(separator: "/").last ?? ""), path: path)
            projects.append(created)
            return ok(["project": created, "is_general": false])
        case let r where r.matches("POST", "/rpc/projects/general"):
            if let existing = projects.first(where: { $0["is_general"] as? Bool == true }) {
                return ok(["project": existing, "is_general": true])
            }
            let created = Self.project("p-general", name: "General", path: "/Users/me/.chro/chats", general: true)
            projects.append(created)
            return ok(["project": created, "is_general": true])
        case let r where r.matches("POST", "/rpc/projects/*/badge-color"):
            let id = r.captures("/rpc/projects/*/badge-color")[0]
            guard let index = projects.firstIndex(where: { $0["id"] as? String == id }) else { return .text(status: 404, contentType: "text/plain", "Not found") }
            projects[index]["badge_color"] = body["badge_color"] ?? NSNull()
            return ok(["project": projects[index], "is_general": projects[index]["is_general"] ?? false])
        case let r where r.matches("GET", "/rpc/filesystem/directory"):
            let path = http.query["path"] ?? "/Users/me"
            guard let listing = directories[path] else { return .text(status: 400, contentType: "text/plain", "Path does not exist") }
            return ok(listing)
        case let r where r.matches("GET", "/rpc/executor/profile"):
            return ok(["profile": profile, "profiles": ["executors": [:]]])
        case let r where r.matches("PUT", "/rpc/executor/profile"):
            profile["executor"] = body["executor"]
            return ok(["profile": profile, "profiles": ["executors": [:]]])
        case let r where r.matches("GET", "/rpc/executor/pi/models"):
            return ok(piModels)
        case let r where r.matches("GET", "/rpc/executor/install-status"):
            return ok(installStatus)
        case let r where r.matches("GET", "/rpc/projects/*/git/branches"):
            return ok(["branches": branches, "isRepository": true])
        case let r where r.matches("GET", "/rpc/skills"):
            return ok(["skills": skills])
        case let r where r.matches("GET", "/rpc/projects/*/search"):
            return ok(["results": searchResults, "total_files": searchResults.count, "total_line_matches": 0, "truncated": false])
        case let r where r.matches("PATCH", "/rpc/tasks/*/status"):
            let id = r.captures("/rpc/tasks/*/status")[0]
            guard var task = tasks[id] else { return .text(status: 404, contentType: "text/plain", "Not found") }
            task["status"] = body["status"]
            task["updated_at"] = "2026-11-14T10:00:00.000Z"
            tasks[id] = task
            announce(["op": "replace", "path": "/tasks/\(id)", "value": task])
            return ok(["task": task])
        case let r where r.matches("POST", "/rpc/tasks/*/cancel"):
            return .empty(status: 204)
        case let r where r.matches("POST", "/rpc/tasks/*/fork"):
            let id = r.captures("/rpc/tasks/*/fork")[0]
            guard let source = tasks[id] else { return .text(status: 404, contentType: "text/plain", "Not found") }
            let fork = Self.task("f0rk0000-0000-4000-8000-000000000001", project: source["project_id"] as! String,
                                 title: "\(source["title"] as? String ?? "") (2)", status: "pending")
            tasks[fork["id"] as! String] = fork
            announce(["op": "add", "path": "/tasks/\(fork["id"] as! String)", "value": fork])
            return ok(["task": fork, "mode": "native"])
        case let r where r.matches("POST", "/v1/sessions"):
            createdCount += 1
            let id = "5e550000-0000-4000-8000-00000000000\(createdCount)"
            let project = projects.first { $0["id"] as? String == body["project"] as? String } ?? Self.project("?", name: "?", path: "/")
            let session: [String: Any] = [
                "id": id, "slug": NSNull(), "title": "", "project": ["id": "00000000-0000-4000-8000-000000000000", "slug": NSNull(), "name": project["name"]!, "path": project["git_repo_path"]!],
                "state": "idle", "status": "pending", "agent": NSNull(), "branch": NSNull(), "worktree": NSNull(), "note": NSNull(),
                "summary": NSNull(), "turn": NSNull(), "queue": [], "parent": NSNull(), "children": [], "created_at": Self.createdAt, "updated_at": Self.createdAt,
            ]
            return ok(["ok": true, "result": ["session": session, "turn": NSNull()], "meta": ["runtime_id": "rt-1", "contract_rev": "0.1.0"]])
        case let r where r.matches("POST", "/rpc/tasks/*/messages"):
            let id = r.captures("/rpc/tasks/*/messages")[0]
            return ok(["execution_id": "run-1", "task_run_id": "run-1", "task_id": id, "project_id": "p", "executor_session_id": "es-1"])
        case let r where r.matches("POST", "/rpc/images/upload"):
            guard let upload = http.upload, upload.field == "image" else { return .text(status: 400, contentType: "text/plain", "missing image") }
            return ok(["image": ["id": "img-\(upload.data.count)", "file_path": ".chro-images/\(upload.fileName)", "original_name": upload.fileName,
                                 "size_bytes": upload.data.count, "hash": "h", "created_at": Self.createdAt, "updated_at": Self.createdAt]])
        default:
            return replies["\(http.method) \(http.path)"] ?? .forbidden
        }
    }
}

/// A request line matched against templates like `/rpc/tasks/*/status`, where
/// `*` stands for one percent-decoded path segment.
private struct Route {
    let method: String
    let segments: [String]

    init(method: String, path: String) {
        self.method = method
        segments = path.split(separator: "/").map { $0.removingPercentEncoding ?? String($0) }
    }

    func matches(_ method: String, _ template: String) -> Bool {
        captures(template, method: method) != nil
    }

    func captures(_ template: String) -> [String] { captures(template, method: method) ?? [] }

    private func captures(_ template: String, method: String) -> [String]? {
        let pattern = template.split(separator: "/")
        guard method == self.method, pattern.count == segments.count else { return nil }
        var captured: [String] = []
        for (expected, actual) in zip(pattern, segments) {
            if expected == "*" { captured.append(actual) } else if expected != actual { return nil }
        }
        return captured
    }
}
