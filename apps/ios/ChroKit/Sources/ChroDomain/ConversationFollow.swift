/// Stick-to-bottom for the conversation (task-conversation.tsx): while the
/// reader is at the end, new content keeps the end in view; scrolling up stops
/// that until the reader returns to within `bottomThreshold` of the end or sends.
public struct ConversationFollow: Equatable, Sendable {
    /// `SCROLL_BOTTOM_THRESHOLD`.
    public static let bottomThreshold = 50.0

    /// Where the viewport is: its offset and the offset that shows the end.
    public struct Geometry: Equatable, Sendable {
        public var offset: Double
        public var bottomOffset: Double

        public init(offset: Double, bottomOffset: Double) {
            self.offset = offset
            self.bottomOffset = bottomOffset
        }

        /// The offset inside the scrollable range: the bounce past either end is not a position.
        var clampedOffset: Double { min(max(offset, 0), max(bottomOffset, 0)) }
        var isAtBottom: Bool { bottomOffset - clampedOffset <= ConversationFollow.bottomThreshold }
    }

    public private(set) var isFollowing = true
    private var lastOffset = 0.0

    public init() {}

    /// The viewport moved, not by `jumped`. A reader's move up stops following, as
    /// any other reader's move follows exactly when it ends at the bottom. A move
    /// the reader did not make (the view clamping after content shrank) cannot stop
    /// following, and resumes it when it leaves the reader at the bottom.
    public mutating func scrolled(to geometry: Geometry, byReader: Bool) {
        let offset = geometry.clampedOffset
        defer { lastOffset = offset }
        if byReader {
            isFollowing = offset >= lastOffset && geometry.isAtBottom
        } else if geometry.isAtBottom {
            isFollowing = true
        }
    }

    /// The view put the end in view itself: opening, a submit, or following new content.
    public mutating func jumped(to geometry: Geometry) {
        isFollowing = true
        lastOffset = geometry.clampedOffset
    }

    /// The view is about to move the reader away from the end on purpose (find, the message navigator, earlier history).
    public mutating func release() {
        isFollowing = false
    }
}
