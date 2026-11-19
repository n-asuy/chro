import ChroAPI
import ChroDomain
import Foundation

/// The wire shapes the desktop's conversation reads, and how a session's
/// conversation is assembled from them (use-conversation-history.ts,
/// conversation-history.ts, single-agent-session.tsx).
enum ConversationWire {
    // MARK: Rows

    /// One task run (`/streams/tasks/:task_id/runs`, crates/db `TaskRun`).
    struct Run: Equatable, Sendable {
        var id: String
        var status: String
        var createdAt: Date
        var targetBranch: String?
        var containerRef: String?
        /// `ExecutorProfileId` as JSON text.
        var executorLabel: String?

        init?(_ value: JSONValue) {
            guard let id = value["id"]?.stringValue, let status = value["status"]?.stringValue else { return nil }
            self.id = id
            self.status = status
            createdAt = value["created_at"]?.stringValue.flatMap(RFC3339.parse) ?? .distantPast
            targetBranch = value["target_branch"]?.stringValue
            containerRef = value["container_ref"]?.stringValue
            executorLabel = value["executor_label"]?.stringValue
        }

        init(id: String, status: String, createdAt: Date, targetBranch: String? = nil, containerRef: String? = nil, executorLabel: String? = nil) {
            self.id = id
            self.status = status
            self.createdAt = createdAt
            self.targetBranch = targetBranch
            self.containerRef = containerRef
            self.executorLabel = executorLabel
        }

        var isActive: Bool { status == "running" || status == "pending" }
    }

    /// One task session (`/streams/tasks/:task_id/sessions`): its prompt is the turn's user message.
    struct TaskSession: Equatable, Sendable {
        var id: String
        var runID: String?
        var prompt: String?

        init?(_ value: JSONValue) {
            guard let id = value["id"]?.stringValue else { return nil }
            self.id = id
            runID = value["task_run_id"]?.stringValue
            prompt = value["prompt"]?.stringValue
        }
    }

    // MARK: Documents

    /// The collection under `key` of a snapshot stream's document, e.g. `{"task_runs": {id: row}}`.
    static func collection(_ document: JSONValue, _ key: String) -> [JSONValue] {
        guard let rows = document[key]?.objectValue else { return [] }
        return Array(rows.values)
    }

    static func runs(_ document: JSONValue) -> [Run] {
        collection(document, "task_runs").compactMap(Run.init).sorted { $0.createdAt < $1.createdAt || ($0.createdAt == $1.createdAt && $0.id < $1.id) }
    }

    static func sessions(_ document: JSONValue) -> [TaskSession] { collection(document, "task_sessions").compactMap(TaskSession.init) }

    /// Queue order: `seq`, then arrival (orderSessionQueue).
    static func queue(_ document: JSONValue) -> [QueuedPrompt] {
        collection(document, "session_queue").compactMap { row -> (Double, String, QueuedPrompt)? in
            guard let id = row["id"]?.stringValue, let prompt = row["prompt"]?.stringValue else { return nil }
            let seq: Double = { if case .number(let n)? = row["seq"] { return n } else { return 0 } }()
            return (seq, row["created_at"]?.stringValue ?? "", QueuedPrompt(id: id, prompt: prompt))
        }
        .sorted { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }
        .map(\.2)
    }

    /// The runs whose history is shown: those with an index at or after `firstShown`.
    /// The desktop loads the newest three finished runs (plus the running one) and three more per page.
    static let historyPage = 3

    // MARK: Logs

    /// One run's log document as its patches built it: entries by index, approvals by id.
    struct RunLog: Equatable, Sendable {
        var entries: [Int: JSONValue] = [:]
        var approvals: [String: JSONValue] = [:]
        /// `{"finished":true}` arrived: the history is complete.
        var finished = false

        /// Applies `{"JsonPatch": [ops]}`; the last op on a path wins.
        mutating func apply(_ operations: [JSONValue]) {
            for operation in operations {
                guard let path = operation["path"]?.stringValue, let op = operation["op"]?.stringValue else { continue }
                let tokens = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map {
                    $0.replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
                }
                guard let head = tokens.first else { continue }
                let value = operation["value"]
                switch (head, tokens.count) {
                case ("entries", 1):
                    entries = [:]
                    if op != "remove", let items = value?.arrayValue { for (index, item) in items.enumerated() { entries[index] = item } }
                case ("entries", 2):
                    guard let index = Int(tokens[1]) else { continue }
                    if op == "remove" { entries[index] = nil } else if let value { entries[index] = value }
                case ("approvals", 1):
                    approvals = op == "remove" ? [:] : (value?.objectValue ?? [:])
                case ("approvals", 2):
                    if op == "remove" { approvals[tokens[1]] = nil } else if let value { approvals[tokens[1]] = value }
                default:
                    continue
                }
            }
        }
    }

    /// A message of `/streams/task-runs/:id/logs`.
    enum LogMessage: Equatable {
        case replayStarted
        case patch([JSONValue])
        case finished
        case failure(String)
        case ignored

        init(_ data: Data) {
            guard case .object(let object)? = try? JSONDecoder().decode(JSONValue.self, from: data) else { self = .ignored; return }
            if case .array(let operations)? = object["JsonPatch"] { self = .patch(operations) }
            else if object["finished"]?.boolValue == true { self = .finished }
            else if object["replayStarted"]?.boolValue == true { self = .replayStarted }
            else if let error = object["error"]?.stringValue { self = .failure(error) }
            else { self = .ignored }
        }
    }

    // MARK: Entries

    /// One `{"type":"NORMALIZED_ENTRY","content":{…}}` value as a conversation entry.
    static func entry(_ value: JSONValue, runID: String, index: Int) -> ConversationEntry? {
        let content = value["type"]?.stringValue == "NORMALIZED_ENTRY" ? value["content"] : value
        guard let content, let type = content["type"], let tag = type["type"]?.stringValue else { return nil }
        let text = content["content"]?.stringValue ?? ""
        let kind: ConversationEntryKind
        switch tag {
        case "user_message": kind = .userMessage(text)
        case "assistant_message": kind = .assistantMessage(text)
        case "thinking": kind = .thinking(text)
        case "loading": kind = .loading(text)
        case "system_message", "user_feedback": kind = .systemMessage(text)
        case "error_message":
            kind = .errorMessage(text, type["error_type"]?["type"]?.stringValue.flatMap(ConversationErrorKind.init(rawValue:)) ?? .other)
        case "tool_use":
            guard let tool = toolUse(type, content: text) else { return nil }
            kind = .toolUse(tool)
        case "next_action":
            guard !text.isEmpty else { return nil }
            kind = .systemMessage(text)
        default:
            return nil
        }
        return ConversationEntry(id: "\(runID):stream-entry:\(index)", runID: runID, timestamp: content["timestamp"]?.stringValue.flatMap(RFC3339.parse), kind: kind)
    }

    static func toolUse(_ type: JSONValue, content: String) -> ToolUse? {
        guard let name = type["tool_name"]?.stringValue, let action = type["action_type"], let tag = action["action"]?.stringValue else { return nil }
        let toolAction: ToolAction
        switch tag {
        case "command_run":
            let result = action["result"].flatMap { result -> CommandResult? in
                guard result != .null else { return nil }
                let exit: CommandResult.ExitStatus? = {
                    guard let status = result["exit_status"], let kind = status["type"]?.stringValue else { return nil }
                    if kind == "exit_code", case .number(let code)? = status["code"] { return .exitCode(Int(code)) }
                    if kind == "success" { return .success(status["success"]?.boolValue ?? false) }
                    return nil
                }()
                return CommandResult(exitStatus: exit, output: result["output"]?.stringValue)
            }
            toolAction = .commandRun(command: action["command"]?.stringValue ?? "", result: result)
        case "file_read": toolAction = .fileRead(path: action["path"]?.stringValue ?? "")
        case "file_edit":
            let changes = (action["changes"]?.arrayValue ?? []).compactMap { change -> ToolFileChange? in
                switch change["action"]?.stringValue {
                case "write": return .write(content: change["content"]?.stringValue ?? "")
                case "delete": return .delete
                case "rename": return .rename(newPath: change["new_path"]?.stringValue ?? "")
                case "edit": return .edit(unifiedDiff: change["unified_diff"]?.stringValue ?? "")
                default: return nil
                }
            }
            toolAction = .fileEdit(path: action["path"]?.stringValue ?? "", changes: changes)
        case "search": toolAction = .search(query: action["query"]?.stringValue ?? "")
        case "web_fetch": toolAction = .webFetch(url: action["url"]?.stringValue ?? "")
        case "tool":
            let arguments = action["arguments"].flatMap { $0 == .null ? nil : $0 }
            let result = action["result"].flatMap { $0 == .null ? nil : ($0["value"] ?? $0) }
            toolAction = .tool(name: action["tool_name"]?.stringValue ?? name, arguments: arguments, result: result)
        case "task_create": toolAction = .taskCreate(description: action["description"]?.stringValue ?? "")
        case "plan_presentation": toolAction = .planPresentation(plan: action["plan"]?.stringValue ?? "")
        case "todo_management":
            let todos = (action["todos"]?.arrayValue ?? []).map { TodoItem(content: $0["content"]?.stringValue ?? "", status: $0["status"]?.stringValue ?? "") }
            toolAction = .todoManagement(todos: todos, operation: action["operation"]?.stringValue ?? "")
        default: toolAction = .other(description: action["description"]?.stringValue ?? "")
        }
        let status: ToolStatus
        switch type["status"]?["status"]?.stringValue {
        case "success": status = .success
        case "failed": status = .failed
        case "denied": status = .denied(reason: type["status"]?["reason"]?.stringValue)
        case "pending_approval":
            status = .pendingApproval(approvalID: type["status"]?["approval_id"]?.stringValue ?? "",
                                      timeoutAt: type["status"]?["timeout_at"]?.stringValue.flatMap(RFC3339.parse))
        case "timed_out": status = .timedOut
        default: status = .created
        }
        return ToolUse(toolName: name, action: toolAction, status: status, content: content)
    }

    /// One run's entries in index order, its prompt (from the task session) first.
    /// A run with a session prompt hides the log's own user messages.
    /// The run's turn: its task session's prompt, its log, and while the run is live the
    /// working sentinel the desktop appends (`createLoadingEntry`); the server never sends one.
    static func entries(run: String, log: RunLog?, prompt: TaskSession?, isLive: Bool = false) -> [ConversationEntry] {
        var result: [ConversationEntry] = []
        if let prompt, let text = prompt.prompt, !text.isEmpty {
            result.append(ConversationEntry(id: "\(run):synthetic-user-\(prompt.id)", runID: run, kind: .userMessage(text)))
        }
        for index in (log?.entries.keys.sorted() ?? []) {
            guard let value = log?.entries[index], let entry = entry(value, runID: run, index: index) else { continue }
            if !result.isEmpty, case .userMessage = entry.kind { continue }
            result.append(entry)
        }
        if isLive { result.append(ConversationEntry(id: "\(run):loading", runID: run, kind: .loading(""))) }
        return result
    }

    /// The run whose log the desktop streams live (use-conversation-history.ts): the running
    /// run, which stays live until its log's `finished` even after the runs stream turns it
    /// terminal (a cleanup race can publish the status first). A finished log is not live again.
    static func liveRun(runs: [Run], logs: [String: RunLog], current: String?) -> String? {
        func isOpen(_ id: String) -> Bool { !(logs[id]?.finished ?? false) }
        if let running = runs.first(where: { $0.status == "running" && isOpen($0.id) }) { return running.id }
        guard let current, isOpen(current), runs.contains(where: { $0.id == current }) else { return nil }
        return current
    }

    // MARK: Approvals

    /// The pending AskUserQuestion or MCP approval of `runID`.
    static func pendingApproval(_ log: RunLog?, runID: String) -> PendingApproval? {
        for (id, approval) in (log?.approvals ?? [:]).sorted(by: { $0.key < $1.key }) {
            guard approval["task_run_id"]?.stringValue.map({ $0 == runID }) ?? true,
                  approval["status"]?["status"]?.stringValue == "pending" else { continue }
            let input = approval["tool_input"]
            switch approval["tool_name"]?.stringValue {
            case QuestionPrompt.toolName?:
                let questions = QuestionPrompt.questions(from: input)
                if !questions.isEmpty { return .question(approvalID: approval["id"]?.stringValue ?? id, questions: questions) }
            case McpApprovalPrompt.toolName?:
                if let prompt = McpApprovalPrompt.parse(input) { return .mcp(approvalID: approval["id"]?.stringValue ?? id, prompt: prompt) }
            default:
                continue
            }
        }
        return nil
    }

    /// `POST /rpc/approvals/:id/respond` (single-agent-session.tsx, mcp-approval-mapping.ts).
    static func respondBody(_ response: ApprovalResponse) -> JSONValue {
        switch response {
        case .question(.answered(let pairs)):
            return .object(["status": .object(["status": .string("approved")]),
                            "answers": .object(Dictionary(pairs.map { ($0.question, JSONValue.string($0.answer)) }, uniquingKeysWith: { first, _ in first }))])
        case .question(.skipped):
            return .object(["status": .object(["status": .string("denied"), "reason": .string(QuestionPrompt.skippedMessage)])])
        case .mcp(let decision):
            return .object(["status": .object(["status": .string(decision.approves ? "approved" : "denied")]),
                            "answers": .object(decision.answers.mapValues(JSONValue.string))])
        }
    }

    // MARK: Runtime

    /// The run's `executor_label` (`{executor, model, reasoning_effort}`), models shown by label.
    static func runtime(_ label: String?, models: [ModelOption]) -> RuntimeChoice? {
        guard let label, let value = try? JSONDecoder().decode(JSONValue.self, from: Data(label.utf8)),
              let agent = value["executor"]?.stringValue.flatMap(AgentKind.init(rawValue:)) else { return nil }
        let model = value["model"]?.stringValue.map { wire in models.first { $0.agent == agent && $0.value == wire }?.label ?? wire }
        return RuntimeChoice(agent: agent, model: model, effort: value["reasoning_effort"]?.stringValue.flatMap(Effort.init(rawValue:)))
    }

    // MARK: References

    /// One `task_context_ref` of `context-refs` (outgoing) or `referenced-by` (incoming).
    struct ContextRef: Equatable, Sendable {
        var taskID: String
        var kind: String
        var targetTaskID: String?
        var path: String?
        var mode: String?
        var label: String?
        var metadata: String?

        init?(_ value: JSONValue) {
            guard let taskID = value["task_id"]?.stringValue, let kind = value["kind"]?.stringValue else { return nil }
            self.taskID = taskID
            self.kind = kind
            targetTaskID = value["target_task_id"]?.stringValue
            path = value["path"]?.stringValue
            mode = value["mode"]?.stringValue
            label = value["label"]?.stringValue
            metadata = value["metadata_json"]?.stringValue
        }

        /// The fork anchor `metadata_json.run_id`.
        var anchorRunID: String? {
            guard let metadata, let value = try? JSONDecoder().decode(JSONValue.self, from: Data(metadata.utf8)) else { return nil }
            return value["run_id"]?.stringValue
        }
    }

    /// lib/session-relations.ts: one row per counterpart with its strongest relation, then paths.
    static func references(outgoing: [ContextRef], incoming: [ContextRef], sessionID: String) -> [SessionReference] {
        let strength = SessionRelation.allCases
        var bySession: [String: SessionRelation] = [:]
        var order: [String] = []
        func note(_ id: String, _ relation: SessionRelation) {
            guard id != sessionID else { return }
            if let current = bySession[id] {
                if strength.firstIndex(of: relation)! < strength.firstIndex(of: current)! { bySession[id] = relation }
            } else {
                bySession[id] = relation
                order.append(id)
            }
        }
        var paths: [SessionReference] = []
        for ref in outgoing {
            if let target = ref.targetTaskID {
                switch ref.kind {
                case "delegate": note(target, .delegatedFrom)
                case "handoff": note(target, .delegatedTo)
                case "fork": note(target, .continuedFrom)
                default: note(target, .uses)
                }
            } else if let path = ref.path {
                let reference = SessionReference(target: .path(path, isDirectory: ref.kind == "directory"), relation: .uses)
                if !paths.contains(reference) { paths.append(reference) }
            }
        }
        for ref in incoming {
            switch ref.kind {
            case "delegate": note(ref.taskID, .delegatedTo)
            case "handoff": note(ref.taskID, .delegatedFrom)
            case "fork": note(ref.taskID, .continuedIn)
            default: note(ref.taskID, .referencedBy)
            }
        }
        return order.map { SessionReference(target: .session(id: $0), relation: bySession[$0]!) } + paths
    }

    // MARK: Branch

    /// `GET /rpc/task-runs/:id/branch-status`.
    static func branchStatus(_ value: JSONValue, runTarget: String?, diff: (additions: Int, deletions: Int)) -> SessionBranchStatus {
        let behind: Int = { if case .number(let n)? = value["commits_behind"] { return Int(n) } else { return 0 } }()
        let files = (value["conflicted_files"]?.arrayValue ?? []).compactMap(\.stringValue)
        let operation = value["conflict_op"]?.stringValue.flatMap(ConflictOperation.init(rawValue:))
        let rebasing = value["is_rebase_in_progress"]?.boolValue ?? false
        let conflict: SessionBranchStatus.Conflict? = files.isEmpty && !rebasing ? nil : .init(operation: operation ?? .rebase, files: files)
        return SessionBranchStatus(additions: diff.additions, deletions: diff.deletions, commitsBehind: behind,
                            targetBranch: value["target_branch"]?.stringValue ?? runTarget, conflict: conflict)
    }

    /// The diff stream's per-file totals (`/diffs/<path>` → `{type:"DIFF", content:{additions, deletions}}`).
    static func applyDiff(_ operations: [JSONValue], to files: inout [String: (Int, Int)]) {
        for operation in operations {
            guard let path = operation["path"]?.stringValue, path.hasPrefix("/diffs") else { continue }
            if path == "/diffs" {
                files = [:]
                for (key, value) in operation["value"]?.objectValue ?? [:] { files[key] = totals(value) }
                continue
            }
            let key = String(path.dropFirst("/diffs/".count)).replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
            if operation["op"]?.stringValue == "remove" { files[key] = nil } else if let value = operation["value"] { files[key] = totals(value) }
        }
    }

    private static func totals(_ value: JSONValue) -> (Int, Int) {
        let content = value["content"] ?? value
        func number(_ key: String) -> Int { if case .number(let n)? = content[key] { return Int(n) } else { return 0 } }
        return (number("additions"), number("deletions"))
    }

}
