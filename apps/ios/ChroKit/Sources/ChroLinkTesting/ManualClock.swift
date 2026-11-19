import Foundation
@testable import ChroLink

/// A clock that only moves when the test advances it.
final class ManualClock: LinkClock, @unchecked Sendable {
    private struct Sleeper {
        let id: UUID
        let deadline: Duration
        let requested: Duration
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var current: Duration = .zero
    private var sleepers: [Sleeper] = []
    private var requestLog: [Duration] = []

    func now() -> Duration {
        lock.withLock { current }
    }

    func sleep(for duration: Duration) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                requestLog.append(duration)
                if Task.isCancelled {
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                } else if duration <= .zero {
                    lock.unlock()
                    continuation.resume()
                } else {
                    sleepers.append(Sleeper(id: id, deadline: current + duration, requested: duration, continuation: continuation))
                    lock.unlock()
                }
            }
        } onCancel: {
            let sleeper = lock.withLock { () -> Sleeper? in
                guard let index = sleepers.firstIndex(where: { $0.id == id }) else { return nil }
                return sleepers.remove(at: index)
            }
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }

    /// Moves time forward and wakes every sleeper whose deadline has passed.
    func advance(by duration: Duration) {
        let due = lock.withLock { () -> [Sleeper] in
            current += duration
            let due = sleepers.filter { $0.deadline <= current }.sorted { $0.deadline < $1.deadline }
            sleepers.removeAll { $0.deadline <= current }
            return due
        }
        for sleeper in due { sleeper.continuation.resume() }
    }

    /// Requested durations of the sleeps in progress.
    var pending: [Duration] {
        lock.withLock { sleepers.map(\.requested) }
    }

    /// Time left on each sleep in progress.
    var remaining: [Duration] {
        lock.withLock { sleepers.map { $0.deadline - current } }
    }

    /// Waits (in real time) until a sleep of exactly `duration` is in progress.
    func waitForSleep(_ duration: Duration) async throws {
        try await eventually("a \(duration) sleep") { self.pending.contains(duration) }
    }
}

struct EventuallyTimedOut: Error, CustomStringConvertible {
    let what: String
    var description: String { "timed out waiting for \(what)" }
}

/// Polls `condition` in real time (up to 5 s) while other tasks make progress.
func eventually(_ what: String, _ condition: @escaping @Sendable () async -> Bool) async throws {
    let start = ContinuousClock.now
    while !(await condition()) {
        if ContinuousClock.now - start > .seconds(5) { throw EventuallyTimedOut(what: what) }
        try await Task.sleep(for: .milliseconds(1))
    }
}
