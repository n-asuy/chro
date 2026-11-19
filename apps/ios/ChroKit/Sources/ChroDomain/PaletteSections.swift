import Foundation

/// Sections of the "Where would you like to go?" palette (palette-navigation.ts).
/// Browsing (empty query) lists commands, sessions that need the user, then a
/// short recency list. Searching ranks commands, projects and sessions, where a
/// title prefix beats a title substring beats a project-name-only match.

public enum PaletteFlag: String, Sendable { case needsInput = "needs_input", failed }

public enum PaletteItem: Equatable, Sendable {
    case command(String)
    case session(SessionSummary, flag: PaletteFlag?)
    case project(String)
}

public enum PaletteSectionID: String, Sendable, CaseIterable {
    case commands, attention, recent, projects, sessions

    /// en.ts paletteSection* headings.
    public var title: String {
        switch self {
        case .commands: return "Commands"
        case .attention: return "Needs attention"
        case .recent: return "Recent"
        case .projects: return "Projects"
        case .sessions: return "Sessions"
        }
    }
}

public struct PaletteSection: Equatable, Sendable {
    public var id: PaletteSectionID
    public var items: [PaletteItem]
}

public struct PaletteCommand: Equatable, Sendable {
    public var id: String
    public var label: String
    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

public enum PaletteSections {
    public static let attentionMax = 5
    public static let recentMax = 15
    public static let projectResultsMax = 8
    public static let sessionResultsMax = 50

    /// - Parameters:
    ///   - sessions: non-archived sessions, most recent first.
    ///   - projects: selectable projects (scratch projects excluded).
    public static func build(query: String, commands: [PaletteCommand], sessions: [SessionSummary], projects: [ProjectSummary],
                             projectNameOf: (String) -> String?, lastViewedAtOf: (String) -> Date?) -> [PaletteSection] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        func item(_ session: SessionSummary) -> PaletteItem { .session(session, flag: flag(session, lastViewedAtOf(session.id))) }
        let sections: [PaletteSection]
        if needle.isEmpty {
            var blocked: [PaletteItem] = [], unseenFailures: [PaletteItem] = []
            for session in sessions {
                switch flag(session, lastViewedAtOf(session.id)) {
                case .needsInput?: blocked.append(item(session))
                case .failed?: unseenFailures.append(item(session))
                case nil: break
                }
            }
            let attention = Array((blocked + unseenFailures).prefix(attentionMax))
            let attentionIDs = Set(attention.compactMap { if case .session(let s, _) = $0 { s.id } else { nil } })
            let recent = sessions.filter { !attentionIDs.contains($0.id) }.prefix(recentMax).map { item($0) }
            sections = [
                PaletteSection(id: .commands, items: commands.map { .command($0.id) }),
                PaletteSection(id: .attention, items: attention),
                PaletteSection(id: .recent, items: Array(recent)),
            ]
        } else {
            let matchingCommands = commands.filter { $0.label.lowercased().contains(needle) }.map { PaletteItem.command($0.id) }
            let matchingProjects = rankTop(projects, limit: projectResultsMax) { project in
                let name = project.name.lowercased()
                return name.hasPrefix(needle) ? 2 : name.contains(needle) ? 1 : 0
            }.map { PaletteItem.project($0.id) }
            let matchingSessions = rankTop(sessions, limit: sessionResultsMax) { session in
                let title = (session.title ?? "").lowercased()
                if title.hasPrefix(needle) { return 3 }
                if title.contains(needle) { return 2 }
                if let project = projectNameOf(session.projectID), project.lowercased().contains(needle) { return 1 }
                return 0
            }.map(item)
            sections = [
                PaletteSection(id: .commands, items: matchingCommands),
                PaletteSection(id: .projects, items: matchingProjects),
                PaletteSection(id: .sessions, items: matchingSessions),
            ]
        }
        return sections.filter { !$0.items.isEmpty }
    }

    static func flag(_ session: SessionSummary, _ lastViewedAt: Date?) -> PaletteFlag? {
        if SessionRunState(session) == .needsInput { return .needsInput }
        if session.marker(lastViewedAt: lastViewedAt) == .failedUnread { return .failed }
        return nil
    }

    /// Score, drop non-matches, keep the top `limit`. Stable: ties keep input order.
    static func rankTop<T>(_ items: [T], limit: Int, score: (T) -> Int) -> [T] {
        var scored: [(item: T, score: Int, index: Int)] = []
        for (index, item) in items.enumerated() {
            let value = score(item)
            if value > 0 { scored.append((item, value, index)) }
        }
        scored.sort { a, b in a.score != b.score ? a.score > b.score : a.index < b.index }
        return scored.prefix(limit).map { $0.item }
    }
}
