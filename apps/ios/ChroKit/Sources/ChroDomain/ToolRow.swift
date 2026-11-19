import ChroAPI
import Foundation

/// How one tool call reads inside a timeline (ToolCallEntryContent, conversation-view.tsx).
public struct ToolRow: Equatable, Sendable {
    public enum IconKind: Equatable, Sendable { case terminal, eye, squarePen, squareCheck, globe, search, hammer }

    /// One titled box of the expanded command detail.
    public struct Section: Equatable, Sendable {
        public enum Body: Equatable, Sendable {
            /// Monospaced, as the command and its output.
            case code(String)
            /// Muted prose, as the exit status or the empty-output note.
            case note(String)
        }

        public var title: String
        public var body: Body

        public init(title: String, body: Body) {
            self.title = title
            self.body = body
        }
    }

    public enum Detail: Equatable, Sendable {
        case command([Section])
        case fileChanges(path: String, changes: [ToolFileChange])
        case structured(arguments: JSONValue?, result: JSONValue?)
        case todos([TodoItem])
    }

    public enum StatusNote: Equatable, Sendable {
        case pending(String)
        /// Shown in the destructive colour: the only red a tool row carries.
        case denied(String)
    }

    public let tool: ToolUse

    public init(_ tool: ToolUse) { self.tool = tool }

    /// AskUserQuestion renders its own status line or answer card instead of a row.
    public var isQuestion: Bool {
        if case .tool = tool.action { return tool.toolName == QuestionPrompt.toolName }
        return false
    }

    public var icon: IconKind {
        switch tool.action {
        case .commandRun: return .terminal
        case .fileRead: return .eye
        case .fileEdit: return .squarePen
        case .todoManagement, .planPresentation: return .squareCheck
        case .webFetch: return .globe
        case .search: return .search
        default: return .hammer
        }
    }

    public var label: String { tool.toolName.isEmpty ? "Command" : tool.toolName }

    private var command: String {
        if case .commandRun(let command, _) = tool.action { return command.trimmingCharacters(in: .whitespacesAndNewlines) }
        return ""
    }

    private var commandResult: CommandResult? {
        if case .commandRun(_, let result) = tool.action { return result }
        return nil
    }

    private var contentLines: [String] {
        let raw = tool.content.trimmingCharacters(in: .whitespacesAndNewlines)
        return raw.isEmpty ? [] : raw.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// The monospaced text after the label.
    public var summary: String? {
        switch tool.action {
        case .commandRun:
            guard let first = ConversationLayout.firstNonEmptyLine(command) else { return nil }
            return "$ \(first)" + (command.contains("\n") ? " …" : "")
        case .fileRead(let path), .fileEdit(let path, _):
            return path.isEmpty ? nil : path
        default:
            let raw = tool.content.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !raw.isEmpty, !raw.contains("\n") else { return nil }
            let candidate = contentLines.first { !$0.isEmpty && !$0.hasPrefix("[Tool]") } ?? ""
            return candidate.isEmpty || candidate == "{" || candidate == "[" || repeatsLabel(candidate) ? nil : candidate
        }
    }

    /// An approval entry's content is the tool name, plus the executor's
    /// " (approval pending)" while it waits (codex/normalize_logs.rs).
    private func repeatsLabel(_ candidate: String) -> Bool {
        candidate == label || candidate == "\(label) (approval pending)"
    }

    /// The summary is the file's path and opens the file.
    public var linkedPath: String? {
        switch tool.action {
        case .fileRead(let path), .fileEdit(let path, _): return path.isEmpty ? nil : path
        default: return nil
        }
    }

    public var canExpand: Bool {
        switch tool.action {
        case .commandRun:
            return !command.isEmpty || !(commandResult?.output ?? "").isEmpty || commandResult?.exitStatus != nil
                || contentLines.contains { !$0.isEmpty && !$0.hasPrefix("[Tool]") }
        case .tool(_, let arguments, let result): return arguments != nil || result != nil
        case .fileEdit(_, let changes): return !changes.isEmpty
        case .todoManagement: return true
        default: return false
        }
    }

    /// A command that failed, was denied or timed out opens to show its output.
    public var startsExpanded: Bool {
        guard case .commandRun = tool.action else { return false }
        switch tool.status {
        case .failed, .denied, .timedOut: return true
        default: return false
        }
    }

    public var detail: Detail? {
        switch tool.action {
        case .commandRun:
            var sections: [Section] = []
            if !command.isEmpty { sections.append(Section(title: "Command", body: .code(command))) }
            if let output = commandResult?.output {
                let empty = output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                sections.append(Section(title: "Output", body: empty ? .note("No output produced.") : .code(output)))
            }
            if let status = commandResult?.exitStatus {
                switch status {
                case .exitCode(let code): sections.append(Section(title: "Status", body: .note("Exit Code \(code)")))
                case .success(let ok): sections.append(Section(title: "Status", body: .note(ok ? "Success" : "Failed")))
                }
            }
            return sections.isEmpty ? nil : .command(sections)
        case .fileEdit(let path, let changes): return changes.isEmpty ? nil : .fileChanges(path: path, changes: changes)
        case .tool(_, let arguments, let result): return arguments == nil && result == nil ? nil : .structured(arguments: arguments, result: result)
        case .todoManagement(let todos, _): return .todos(todos)
        default: return nil
        }
    }

    public var statusNote: StatusNote? {
        switch tool.status {
        case .pendingApproval(_, let timeoutAt):
            let timeout = timeoutAt.map { ISO8601DateFormatter().string(from: $0) } ?? "--"
            return .pending("Pending approval (timeout: \(timeout))")
        case .denied(let reason?) where !reason.isEmpty:
            return .denied("Denial Reason: \(reason)")
        default:
            return nil
        }
    }
}
