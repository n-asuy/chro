import Foundation

/// How sessions are ordered inside each left-panel group (projects-panel.tsx SortMode).
public enum SessionSortMode: String, Sendable, CaseIterable, Codable {
    case recent
    case nameAscending = "name-asc"
    case nameDescending = "name-desc"

    /// en.ts sortProjects* labels.
    public var label: String {
        switch self {
        case .recent: return "Recent activity"
        case .nameAscending: return "Name (A→Z)"
        case .nameDescending: return "Name (Z→A)"
        }
    }

    /// Under a recency sort a delegation tree rises with its newest member.
    public var treeRank: TreeRank { self == .recent ? .subtree : .root }
}

public enum SessionListOrder {
    public static func sortSessions(_ sessions: [SessionSummary], mode: SessionSortMode) -> [SessionSummary] {
        sessions.enumerated().sorted { a, b in
            let order: ComparisonResult
            switch mode {
            case .recent:
                order = a.element.updatedAt == b.element.updatedAt ? .orderedSame : (a.element.updatedAt > b.element.updatedAt ? .orderedAscending : .orderedDescending)
            case .nameAscending:
                order = (a.element.title ?? "").localizedCompare(b.element.title ?? "")
            case .nameDescending:
                order = (b.element.title ?? "").localizedCompare(a.element.title ?? "")
            }
            return order == .orderedSame ? a.offset < b.offset : order == .orderedAscending
        }.map(\.element)
    }

    /// Open projects render as sections even when empty: latest activity first
    /// under `recent` (ties by name), by name otherwise.
    public static func orderProjects(_ projects: [ProjectSummary], sessions: [SessionSummary], mode: SessionSortMode) -> [ProjectSummary] {
        var lastActivity: [String: Date] = [:]
        for session in sessions {
            lastActivity[session.projectID] = max(lastActivity[session.projectID] ?? .distantPast, session.updatedAt)
        }
        return projects.sorted { a, b in
            switch mode {
            case .recent:
                let la = lastActivity[a.id] ?? .distantPast, lb = lastActivity[b.id] ?? .distantPast
                if la != lb { return la > lb }
                return a.name.localizedCompare(b.name) == .orderedAscending
            case .nameAscending: return a.name.localizedCompare(b.name) == .orderedAscending
            case .nameDescending: return a.name.localizedCompare(b.name) == .orderedDescending
            }
        }
    }
}

/// The three fixed bands of the left panel.
public enum SessionListSection: String, Sendable, CaseIterable, Codable {
    case pinned, projects, chats

    public var title: String {
        switch self {
        case .pinned: return "Pinned"
        case .projects: return "Projects"
        case .chats: return "Chats"
        }
    }
}

/// The left panel as rows: Pinned (flat, urgency then pin time), one group per
/// open project, and Chats (scratch sessions). A session belongs when its
/// project is open or is a scratch project; pinned sessions leave their group.
public struct SessionListLayout: Equatable, Sendable {
    public struct ProjectGroup: Equatable, Sendable, Identifiable {
        public var project: ProjectSummary
        public var rows: [SessionListRow]
        public var id: String { project.id }
    }

    public var pinned: [SessionListRow]
    public var projects: [ProjectGroup]
    public var chats: [SessionListRow]

    public init(sessions: [SessionSummary], openProjects: [ProjectSummary], scratchProjectIDs: Set<String>, pins: [String: Date],
                sortMode: SessionSortMode, nestDelegations: Bool, collapsedDelegations: Set<String>) {
        let openIDs = Set(openProjects.map(\.id))
        let inbox = sessions.filter { openIDs.contains($0.projectID) || scratchProjectIDs.contains($0.projectID) }
        let pinnedSessions = inbox.filter { pins[$0.id] != nil }
        let unpinned = SessionListOrder.sortSessions(inbox.filter { pins[$0.id] == nil }, mode: sortMode)
        func rows(_ list: [SessionSummary]) -> [SessionListRow] {
            SessionRows.build(list, nest: nestDelegations, collapsed: collapsedDelegations, rank: sortMode.treeRank)
        }
        pinned = SessionRows.build(PinnedSessions.sorted(pinnedSessions, pins: pins), nest: false, collapsed: [], rank: .root)
        projects = SessionListOrder.orderProjects(openProjects.filter { !scratchProjectIDs.contains($0.id) }, sessions: inbox, mode: sortMode)
            .map { project in ProjectGroup(project: project, rows: rows(unpinned.filter { $0.projectID == project.id })) }
        chats = rows(unpinned.filter { scratchProjectIDs.contains($0.projectID) })
    }

    /// The count a collapsed section header shows.
    public func count(of section: SessionListSection) -> Int {
        switch section {
        case .pinned: return pinned.count
        case .projects: return projects.count
        case .chats: return chats.count
        }
    }
}

/// The connector the left panel draws between the focused session and the
/// sessions it delegated to or was delegated from.
public enum RelatedSessions {
    /// Empty unless the focus has at least one listed neighbour.
    public static func ids(focus: String?, in sessions: [SessionSummary]) -> [String] {
        guard let focus, let focused = sessions.first(where: { $0.id == focus }) else { return [] }
        let neighbours = Set(sessions.filter { $0.delegatedFromID == focus }.map(\.id) + [focused.delegatedFromID].compactMap { $0 })
        let ids = sessions.map(\.id).filter { $0 == focus || neighbours.contains($0) }
        return ids.count > 1 ? ids : []
    }
}
