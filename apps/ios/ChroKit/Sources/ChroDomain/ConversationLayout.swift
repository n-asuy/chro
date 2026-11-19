import Foundation

/// One user turn: the prompt (pinned while its response scrolls) and the
/// segments that follow it (conversation-view.tsx `Group`).
public struct ConversationTurn: Identifiable, Equatable, Sendable {
    /// The prompt's entry id, or the first entry's for entries before any prompt.
    public var id: String
    public var prompt: ConversationEntry?
    public var segments: [ConversationSegment]
    /// The turn's final assistant message: only it carries Copy and "Continue in a new session from here".
    public var lastAssistantEntryID: String?
    /// The run that final message came from: where a continuation from this turn anchors.
    public var anchorRunID: String?
    /// Every entry was copied from the session this one continues.
    public var isInherited: Bool
}

public enum ConversationSegment: Identifiable, Equatable, Sendable {
    case entry(ConversationEntry)
    case steps(StepsSegment)

    public var id: String {
        switch self {
        case .entry(let entry): return entry.id
        case .steps(let steps): return steps.id
        }
    }
}

/// A run of consecutive working entries (thinking, tool calls, the loading
/// sentinel) drawn as one collapsible timeline.
public struct StepsSegment: Identifiable, Equatable, Sendable {
    public var id: String
    public var entries: [ConversationEntry]
    /// The agent is still working inside this run: it ends in loading, or a tool waits for approval.
    public var isLive: Bool
    /// A tool waits for approval: the timeline opens by itself.
    public var awaitingApproval: Bool
    /// Reasoning prose, else the latest tool summary; nil shows the static placeholder.
    public var label: String?

    /// The header: the label, else "Thinking", live or not (conversation-view.tsx `thinkingLabel`).
    public var headerText: String { label ?? "Thinking" }
}

/// The "Run with <model> reasoning effort: <effort>" system line.
public struct RunWithLine: Equatable, Sendable {
    public var model: String
    public var effort: String?

    public init(model: String, effort: String?) {
        self.model = model
        self.effort = effort
    }

    private static let pattern = try! NSRegularExpression(pattern: #"^Run with (.+?)(?:\s+reasoning effort:\s*(.+))?$"#)

    /// `/^Run with (.+?)(?:\s+reasoning effort:\s*(.+))?$/` (conversation-view.tsx)
    public static func parse(_ content: String) -> RunWithLine? {
        let range = NSRange(content.startIndex..., in: content)
        guard let match = pattern.firstMatch(in: content, range: range),
              let model = Range(match.range(at: 1), in: content) else { return nil }
        let effort = Range(match.range(at: 2), in: content).map { String(content[$0]) }
        return RunWithLine(model: String(content[model]), effort: effort)
    }

    /// The system message the server writes at the start of a turn.
    public var content: String {
        effort.map { "Run with \(model) reasoning effort: \($0)" } ?? "Run with \(model)"
    }
}

/// One past prompt in "Jump to a past message".
public struct MessageNavItem: Identifiable, Equatable, Sendable {
    public var entryID: String
    public var label: String
    public var id: String { entryID }
}

extension ConversationEntryKind {
    public var userContent: String? {
        if case .userMessage(let content) = self { return content }
        return nil
    }

    public var assistantContent: String? {
        if case .assistantMessage(let content) = self { return content }
        return nil
    }

    var isStep: Bool {
        switch self {
        case .thinking, .toolUse, .loading: return true
        default: return false
        }
    }
}

/// The conversation's layout rules, shared with the desktop.
public enum ConversationLayout {
    /// The navigator appears once there are two prompts to choose between.
    public static let navigatorMinimumPrompts = 2

    /// Groups entries into user turns; entries before the first prompt form a turn of their own.
    /// `approvalOnCard` is the MCP approval the card under the conversation is
    /// answering: the card stands for that tool call, so the timeline does not repeat it.
    public static func turns(_ entries: [ConversationEntry], approvalOnCard: String? = nil) -> [ConversationTurn] {
        var groups: [(prompt: ConversationEntry?, following: [ConversationEntry])] = []
        var promptOpen = false
        for entry in entries {
            if case .userMessage = entry.kind {
                groups.append((entry, []))
                promptOpen = true
            } else if promptOpen {
                groups[groups.count - 1].following.append(entry)
            } else {
                groups.append((nil, [entry]))
            }
        }
        return groups.map { group in
            let all = (group.prompt.map { [$0] } ?? []) + group.following
            let lastAssistant = group.following.last { $0.kind.assistantContent != nil && !$0.isInherited }
            return ConversationTurn(
                id: (group.prompt ?? group.following[0]).id,
                prompt: group.prompt,
                segments: segments(group.following, approvalOnCard: approvalOnCard),
                lastAssistantEntryID: lastAssistant?.id,
                anchorRunID: lastAssistant?.runID,
                isInherited: !all.isEmpty && all.allSatisfy(\.isInherited)
            )
        }
    }

    /// Splits a turn's entries into passthrough entries and timelines.
    public static func segments(_ entries: [ConversationEntry], approvalOnCard: String? = nil) -> [ConversationSegment] {
        var segments: [ConversationSegment] = []
        var run: [ConversationEntry] = []
        var runHasCardApproval = false
        var carriedThinking: String?

        func flush() {
            defer { runHasCardApproval = false }
            guard let first = run.first, let last = run.last else { return }
            let awaitingApproval = runHasCardApproval
                || run.contains { if case .toolUse(let tool) = $0.kind { return tool.status.isPendingApproval } else { return false } }
            var thinkingSummary: String?
            var toolSummary: String?
            for entry in run.reversed() {
                guard let summary = stepSummary(entry.kind) else { continue }
                if case .thinking = entry.kind {
                    thinkingSummary = summary
                    break
                }
                if toolSummary == nil { toolSummary = summary }
            }
            if let thinkingSummary { carriedThinking = thinkingSummary }
            let loadingOnly = run.allSatisfy { if case .loading = $0.kind { return true } else { return false } }
            let isLoading: Bool = { if case .loading = last.kind { return true } else { return false } }()
            segments.append(.steps(StepsSegment(
                id: "steps:\(first.id)",
                entries: run,
                isLive: isLoading || awaitingApproval,
                awaitingApproval: awaitingApproval,
                label: thinkingSummary ?? (loadingOnly ? nil : carriedThinking) ?? toolSummary
            )))
            run = []
        }

        for entry in entries {
            if entry.kind.isStep {
                if case .thinking(let text) = entry.kind, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
                if let approvalOnCard, isMcpApproval(entry.kind, id: approvalOnCard) {
                    runHasCardApproval = true
                    continue
                }
                run.append(entry)
                continue
            }
            flush()
            segments.append(.entry(entry))
        }
        flush()
        return segments
    }

    private static func isMcpApproval(_ kind: ConversationEntryKind, id: String) -> Bool {
        guard case .toolUse(let tool) = kind, tool.toolName == McpApprovalPrompt.toolName,
              case .pendingApproval(let approvalID, _) = tool.status else { return false }
        return approvalID == id
    }

    /// The one-line label of a working entry; nil when it has nothing to show.
    public static func stepSummary(_ kind: ConversationEntryKind) -> String? {
        switch kind {
        case .toolUse(let tool):
            let fallback = tool.toolName.isEmpty ? nil : tool.toolName
            switch tool.action {
            case .commandRun(let command, _):
                return firstNonEmptyLine(command).map { "$ \($0)" } ?? fallback
            case .fileRead(let path), .fileEdit(let path, _):
                return path.isEmpty ? fallback : path
            case .search(let query):
                return query.isEmpty ? fallback : query
            case .webFetch(let url):
                return url.isEmpty ? fallback : url
            default:
                return fallback
            }
        case .thinking(let text):
            guard let line = firstNonEmptyLine(text) else { return nil }
            let stripped = stripMarkdownMarkers(line)
            return stripped.isEmpty ? nil : stripped
        case .loading(let text):
            return firstNonEmptyLine(text)
        default:
            return nil
        }
    }

    /// The working sentinel's shimmer: its progress message, else `processingPlaceholder`.
    public static func loadingStepText(_ content: String) -> String { content.isEmpty ? "In Progress..." : content }

    /// text-shimmer.tsx `bg-[length:250%_100%]`: the highlight gradient is this many label widths wide.
    public static let shimmerGradientScale = 2.5

    /// Where the highlight's peak sits along a label `width` wide at `phase` (0 to 1) of one sweep.
    /// The CSS animates `background-position` from 100% to 0%, so the peak runs left to right,
    /// entering a quarter width before the label and leaving a quarter width after it.
    public static func shimmerHighlightCenter(width: Double, phase: Double) -> Double {
        let travel = (shimmerGradientScale - 1) * width
        return -travel * (1 - phase) + shimmerGradientScale * width / 2
    }

    /// Copy and "Continue in a new session from here" wait until the turn has finished.
    public static func showsMessageActions(turnIndex: Int, turnCount: Int, isRunning: Bool) -> Bool {
        !(isRunning && turnIndex == turnCount - 1)
    }

    /// The prompts "Jump to a past message" lists, by their first line of text.
    public static func navItems(_ entries: [ConversationEntry]) -> [MessageNavItem] {
        entries.compactMap { entry in
            guard let content = entry.kind.userContent else { return nil }
            let text = PromptContent.parse(content).text
            let label = firstNonEmptyLine(text) ?? content.trimmingCharacters(in: .whitespacesAndNewlines)
            return MessageNavItem(entryID: entry.id, label: label)
        }
    }

    static func firstNonEmptyLine(_ text: String) -> String? {
        for line in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    /// Drops the emphasis, code and heading/list/quote markers that lead a thinking line.
    static func stripMarkdownMarkers(_ line: String) -> String {
        var text = line
        text = text.replacingOccurrences(of: #"\*\*([^*]+)\*\*"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\*([^*]+)\*"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"^[#>\-*\s]+"#, with: "", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespaces)
    }
}
