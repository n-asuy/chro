import Foundation

/// Fan-out of a whole-state value to every `AsyncStream` subscriber: a new
/// subscriber gets the current value first, then each change.
///
/// Delivery happens under the same lock as the mutation, so every subscriber
/// sees snapshots in mutation order (a registration's first snapshot never
/// arrives after a later update). Each subscriber buffers only the newest
/// snapshot: a reader that falls behind skips to the current state instead of
/// queueing every intermediate one.
public final class ServiceBroadcast<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Value
    private var continuations: [UUID: AsyncStream<Value>.Continuation] = [:]
    private var publishedHook: (@Sendable () -> Void)?
    private var publishedRevision: UInt64 = 0
    /// Readers that went away, removed at the next publication. Kept under its own
    /// lock: a reader's termination runs while the runtime holds that task's lock,
    /// and a publication holds `lock` while it resumes readers (taking task locks),
    /// so termination must never wait for `lock`.
    private let departedLock = NSLock()
    private var departed: [UUID] = []

    public init(_ initial: Value) { current = initial }

    public var value: Value {
        lock.withLock { current }
    }

    /// Runs after each publication, outside the lock. Tests use it to interleave
    /// another thread's update deterministically.
    var afterPublishing: (@Sendable () -> Void)? {
        get { lock.withLock { publishedHook } }
        set { lock.withLock { publishedHook = newValue } }
    }

    public func stream() -> AsyncStream<Value> {
        let (stream, continuation) = AsyncStream<Value>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let id = UUID()
        let hook = lock.withLock { () -> (@Sendable () -> Void)? in
            forgetDeparted()
            continuations[id] = continuation
            continuation.yield(current)
            return publishedHook
        }
        continuation.onTermination = { [weak self] _ in
            guard let self else { return }
            self.departedLock.withLock { self.departed.append(id) }
        }
        hook?()
        return stream
    }

    /// Mutate the value and publish the result.
    public func update(_ change: (inout Value) -> Void) {
        let hook = lock.withLock { () -> (@Sendable () -> Void)? in
            forgetDeparted()
            change(&current)
            for continuation in continuations.values { continuation.yield(current) }
            return publishedHook
        }
        hook?()
    }

    /// Publishes a snapshot derived from state kept elsewhere. `revision` is taken
    /// under that state's lock when the snapshot is derived; a snapshot older than
    /// the last one published (a slower publisher arriving late) is dropped.
    public func publish(_ value: Value, revision: UInt64) {
        let hook = lock.withLock { () -> (@Sendable () -> Void)? in
            guard revision > publishedRevision else { return nil }
            publishedRevision = revision
            forgetDeparted()
            current = value
            for continuation in continuations.values { continuation.yield(current) }
            return publishedHook
        }
        hook?()
    }

    /// Readers still registered (for tests).
    var subscriberCount: Int {
        lock.withLock {
            forgetDeparted()
            return continuations.count
        }
    }

    /// Called with `lock` held.
    private func forgetDeparted() {
        let gone = departedLock.withLock { () -> [UUID] in
            defer { departed.removeAll() }
            return departed
        }
        for id in gone { continuations[id] = nil }
    }
}
