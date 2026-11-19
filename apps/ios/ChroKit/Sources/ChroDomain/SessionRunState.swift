import Foundation

/// A session's stored status and live flags collapsed into one state
/// (session-grouping.ts deriveSessionState). Awaiting input wins over running:
/// the agent is blocked on the user. An attached run reads as running whatever
/// the stored status says.
public enum SessionRunState: String, Sendable, CaseIterable {
    case needsInput = "needs_input"
    case running, pending, completed, failed, cancelled

    public init(_ session: SessionSummary) {
        if session.awaitingInput { self = .needsInput; return }
        if session.isRunning { self = .running; return }
        switch session.status {
        case "completed": self = .completed
        case "failed": self = .failed
        case "cancelled": self = .cancelled
        case "in_progress": self = .running
        default: self = .pending
        }
    }
}

/// Order of the Pinned section (session-grouping.ts sortPinnedSessions): a pin
/// waiting on the user floats to the top, then failures, then the rest by the
/// most recent pin.
public enum PinnedSessions {
    public static func sorted(_ sessions: [SessionSummary], pins: [String: Date]) -> [SessionSummary] {
        func urgency(_ session: SessionSummary) -> Int {
            switch SessionRunState(session) {
            case .needsInput: return 0
            case .failed: return 1
            default: return 2
            }
        }
        func pinnedAt(_ id: String) -> TimeInterval { pins[id]?.timeIntervalSince1970 ?? 0 }
        return sessions.enumerated().sorted { a, b in
            let ua = urgency(a.element), ub = urgency(b.element)
            if ua != ub { return ua < ub }
            let pa = pinnedAt(a.element.id), pb = pinnedAt(b.element.id)
            if pa != pb { return pa > pb }
            return a.offset < b.offset
        }.map(\.element)
    }
}
