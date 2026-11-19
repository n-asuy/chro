import Foundation

/// One rendered line of a left-panel section (session-rows.ts SessionListRow).
public struct SessionListRow: Equatable, Sendable, Identifiable {
    public var session: SessionSummary
    /// Nesting level, 0 at the top of the section.
    public var depth: Int
    /// The row this one sits under; nil at the top level.
    public var parentID: String?
    /// Sessions nested under this row at any depth, shown or not.
    public var descendantCount: Int
    /// Whether the nested sessions are shown. False for a leaf.
    public var expanded: Bool
    /// Direct children shown below this row that are running.
    public var shownRunningChildren: Int
    /// A session hidden under this collapsed row is waiting on the user.
    public var hiddenNeedsInput: Bool

    public var id: String { session.id }
}

/// Where a delegation tree sits among its siblings: `root` keeps the
/// delegating session's own position, `subtree` lifts the tree to its
/// earliest member so active delegated work does not sink under a recency sort.
public enum TreeRank: Sendable { case root, subtree }

public struct SessionPreview: Equatable, Sendable {
    public var visible: [SessionListRow]
    /// Rows folded away; 0 means the section is shown in full.
    public var hiddenCount: Int
}

public enum SessionRows {
    /// Rows a long section shows before "Show N more" (SESSION_PREVIEW_LIMIT).
    public static let previewLimit = 5

    /// Turn a section's sessions (already sorted) into rows. Only a delegation
    /// edge nests, and only when the delegator is in the same list. Sessions on
    /// a delegation cycle stay at the top level.
    public static func build(_ sessions: [SessionSummary], nest: Bool, collapsed: Set<String>, rank: TreeRank) -> [SessionListRow] {
        guard nest else { return sessions.map { topLevel($0) } }

        var indexOf: [String: Int] = [:]
        for (index, session) in sessions.enumerated() where indexOf[session.id] == nil { indexOf[session.id] = index }
        func listedParent(_ session: SessionSummary) -> String? {
            guard let parent = session.delegatedFromID, indexOf[parent] != nil else { return nil }
            return parent
        }
        func onCycle(_ session: SessionSummary) -> Bool {
            var seen = Set<String>()
            var at = listedParent(session)
            while let current = at, !seen.contains(current) {
                if current == session.id { return true }
                seen.insert(current)
                at = listedParent(sessions[indexOf[current]!])
            }
            return false
        }

        var roots: [SessionSummary] = []
        var children: [String: [SessionSummary]] = [:]
        for session in sessions {
            if !onCycle(session), let parent = listedParent(session) {
                children[parent, default: []].append(session)
            } else {
                roots.append(session)
            }
        }

        var rankCache: [String: Int] = [:]
        func rankOf(_ session: SessionSummary) -> Int {
            if let cached = rankCache[session.id] { return cached }
            let own = indexOf[session.id]!
            let value = rank == .subtree ? ([own] + (children[session.id] ?? []).map(rankOf)).min()! : own
            rankCache[session.id] = value
            return value
        }
        func ordered(_ level: [SessionSummary]) -> [SessionSummary] {
            level.enumerated().sorted { (rankOf($0.element), $0.offset) < (rankOf($1.element), $1.offset) }.map(\.element)
        }
        func descendants(_ session: SessionSummary) -> [SessionSummary] {
            (children[session.id] ?? []).flatMap { [$0] + descendants($0) }
        }

        var rows: [SessionListRow] = []
        func visit(_ session: SessionSummary, depth: Int, parentID: String?) {
            let kids = ordered(children[session.id] ?? [])
            let hidden = descendants(session)
            let expanded = !kids.isEmpty && !collapsed.contains(session.id)
            rows.append(SessionListRow(
                session: session, depth: depth, parentID: parentID, descendantCount: hidden.count, expanded: expanded,
                shownRunningChildren: expanded ? kids.filter(\.isRunning).count : 0,
                hiddenNeedsInput: !expanded && hidden.contains { SessionRunState($0) == .needsInput }
            ))
            if expanded { for kid in kids { visit(kid, depth: depth + 1, parentID: session.id) } }
        }
        for root in ordered(roots) { visit(root, depth: 0, parentID: nil) }
        return rows
    }

    /// Fold a section to its first rows. The focused session and sessions
    /// waiting on the user stay visible at their position, with the rows they
    /// are nested under. Folding only applies when it hides at least two rows.
    /// `unheld` sessions belong to the section but the host has not sent them
    /// yet (a windowed list): they always count as hidden.
    public static func preview(_ rows: [SessionListRow], isActive: (SessionSummary) -> Bool, unheld: Int = 0) -> SessionPreview {
        let held = foldHeld(rows, isActive: isActive)
        return SessionPreview(visible: held.visible, hiddenCount: held.hiddenCount + max(0, unheld))
    }

    private static func foldHeld(_ rows: [SessionListRow], isActive: (SessionSummary) -> Bool) -> SessionPreview {
        var parentOf: [String: String?] = [:]
        for row in rows { parentOf[row.session.id] = row.parentID }
        var kept = Set<String>()
        for (index, row) in rows.enumerated()
        where index < previewLimit || isActive(row.session) || SessionRunState(row.session) == .needsInput || row.hiddenNeedsInput {
            var id: String? = row.session.id
            while let current = id, !kept.contains(current) {
                kept.insert(current)
                id = parentOf[current] ?? nil
            }
        }
        let visible = rows.filter { kept.contains($0.session.id) }
        let hiddenCount = rows.count - visible.count
        if hiddenCount < 2 { return SessionPreview(visible: rows, hiddenCount: 0) }
        return SessionPreview(visible: visible, hiddenCount: hiddenCount)
    }

    private static func topLevel(_ session: SessionSummary) -> SessionListRow {
        SessionListRow(session: session, depth: 0, parentID: nil, descendantCount: 0, expanded: false, shownRunningChildren: 0, hiddenNeedsInput: false)
    }
}
