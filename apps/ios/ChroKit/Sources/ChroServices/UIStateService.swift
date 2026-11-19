import ChroDomain
import Foundation

/// The session list's view preferences. They are shared with the desktop
/// through the server's UI state (`/rpc/ui-state`), under the desktop's keys.
public struct SessionListPreferences: Equatable, Sendable {
    /// Task id to pin time (`workspace-layout:pinned-sessions:v1`).
    public var pins: [String: Date]
    /// Task id to last view, the read watermark (`session:read-state:v1`).
    public var viewedAt: [String: Date]
    /// `workspace-layout:projects-sort-mode:v1`.
    public var sortMode: SessionSortMode
    /// `workspace-layout:projects-collapsed-sections:v1`.
    public var collapsedSections: Set<SessionListSection>
    /// `workspace-layout:nest-delegations:v1` (Settings → Workspace).
    public var nestDelegations: Bool

    public init(pins: [String: Date] = [:], viewedAt: [String: Date] = [:], sortMode: SessionSortMode = .recent,
                collapsedSections: Set<SessionListSection> = [], nestDelegations: Bool = true) {
        self.pins = pins
        self.viewedAt = viewedAt
        self.sortMode = sortMode
        self.collapsedSections = collapsedSections
        self.nestDelegations = nestDelegations
    }

    public enum Key {
        public static let pins = "workspace-layout:pinned-sessions:v1"
        public static let viewedAt = "session:read-state:v1"
        public static let sortMode = "workspace-layout:projects-sort-mode:v1"
        public static let collapsedSections = "workspace-layout:projects-collapsed-sections:v1"
        public static let nestDelegations = "workspace-layout:nest-delegations:v1"
    }
}

/// Reads and writes the shared UI state the session list depends on.
public protocol UIStateService: Sendable {
    func preferences() -> AsyncStream<SessionListPreferences>
    /// Pin when unpinned (now), unpin when pinned.
    func togglePin(sessionID: String) async
    /// Record that the user has just seen a session, clearing its unread marker.
    func markViewed(sessionID: String) async
    func setSortMode(_ mode: SessionSortMode) async
    func setCollapsedSections(_ sections: Set<SessionListSection>) async
}
