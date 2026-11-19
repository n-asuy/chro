import Foundation

/// Live and archived sessions of one project on the host, whether or not the
/// phone holds them (crates/db `SessionCounts`).
public struct SessionCounts: Equatable, Sendable, Hashable {
    public var live: Int
    public var archived: Int

    public init(live: Int, archived: Int) {
        self.live = live
        self.archived = archived
    }
}

/// What the phone asks the host's session list stream to hold
/// (`/streams/session-list`, crates/db `SessionWindow`): per project the first
/// rows of the list's order and the newest rows, the sessions it pinned or
/// opened, and the projects extended with "Show more". The host adds the
/// newest sessions across projects, sessions that need the user, and whole
/// delegation trees.
public struct SessionListWindow: Equatable, Sendable {
    /// Rows per project: Home's Recent shows 8, the list previews 5 and keeps a margin.
    public static let perProject = 10
    /// Rows one "Show more" adds.
    public static let pageSize = 50
    /// Most sessions one window names (the host refuses more).
    public static let maxIncluded = 500

    public var sortMode: SessionSortMode
    /// Rows held per project after "Show more", in the list's order.
    public private(set) var projectLimits: [String: Int] = [:]
    /// Sessions held regardless of their position, oldest first.
    public private(set) var held: [String] = []

    public init(sortMode: SessionSortMode = .recent) {
        self.sortMode = sortMode
    }

    /// Rows of the list's order held for `projectID`.
    public func limit(for projectID: String) -> Int { projectLimits[projectID] ?? Self.perProject }

    /// The next page of `projectID`: where it starts and how many rows it asks for.
    public func nextPage(of projectID: String) -> (offset: Int, limit: Int) { (limit(for: projectID), Self.pageSize) }

    /// Records that `projectID` now holds its rows up to the page that starts at `offset`.
    public mutating func extend(_ projectID: String, through page: (offset: Int, limit: Int)) {
        projectLimits[projectID] = max(limit(for: projectID), page.offset + page.limit)
    }

    /// Keeps `sessionID` across reconnects (an opened session outside the window).
    public mutating func hold(_ sessionID: String) {
        guard !held.contains(sessionID) else { return }
        held.append(sessionID)
        if held.count > Self.maxIncluded { held.removeFirst(held.count - Self.maxIncluded) }
    }

    /// The subscription's parameters; `pinned` sessions are always included.
    public func params(pinned: [String]) -> [String: String] {
        var include: [String] = []
        for id in pinned.sorted() + held.reversed() where !include.contains(id) && include.count < Self.maxIncluded { include.append(id) }
        var params = ["sort": sortMode.rawValue, "limit": String(Self.perProject)]
        if !projectLimits.isEmpty {
            params["project_limits"] = projectLimits.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }.joined(separator: ",")
        }
        if !include.isEmpty { params["include"] = include.joined(separator: ",") }
        return params
    }
}
