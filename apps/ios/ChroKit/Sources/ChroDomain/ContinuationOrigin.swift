import Foundation

/// Where a continued session came from (conversation-fork-origin.tsx): the
/// source's recent history dimmed above a "Continued from task" boundary.
public struct ContinuationOrigin: Equatable, Sendable {
    /// How many of the source's runs are inlined above the boundary.
    public static let maxInlinedRuns = 5

    public enum History: Equatable, Sendable {
        /// The conversation was duplicated: the source's entries up to the anchor.
        case native([ConversationEntry])
        /// Only a summary carried over: the source's last prompt and reply.
        case digest(user: String?, assistant: String?)
    }

    public var sourceSessionID: String
    /// The source's title when the session was continued (the link's tooltip).
    public var sourceTitle: String?
    public var history: History

    public init(sourceSessionID: String, sourceTitle: String?, history: History) {
        self.sourceSessionID = sourceSessionID
        self.sourceTitle = sourceTitle
        self.history = history
    }

    /// The inherited entries of a native continuation; nil for a digest.
    public var nativeEntries: [ConversationEntry]? {
        if case .native(let entries) = history { return entries }
        return nil
    }

    public var linkTitle: String {
        if case .digest = history { return "Continued from task (summary)" }
        return "Continued from task"
    }

    /// The runs inlined above the boundary: up to the anchor (the fork never saw
    /// what came after), at most the last five. An unknown anchor keeps them all.
    public static func inlinedRuns(ascending runIDs: [String], anchorRunID: String?) -> [String] {
        let upToAnchor = anchorRunID.flatMap { anchor in runIDs.firstIndex(of: anchor).map { Array(runIDs[...$0]) } } ?? runIDs
        return Array(upToAnchor.suffix(maxInlinedRuns))
    }

    /// The source's entries of the inlined runs, marked inherited.
    public static func inheritedEntries(_ entries: [ConversationEntry], anchorRunID: String?) -> [ConversationEntry] {
        var runs: [String] = []
        for entry in entries where !runs.contains(entry.runID) { runs.append(entry.runID) }
        let kept = Set(inlinedRuns(ascending: runs, anchorRunID: anchorRunID))
        return entries.filter { kept.contains($0.runID) }.map { entry in
            var copy = entry
            copy.isInherited = true
            return copy
        }
    }
}
