import Foundation

/// Monotonic time and sleeping, injected so deadlines, timeouts, the reconnect
/// schedule and the liveness watchdog are testable without waiting.
public protocol LinkClock: Sendable {
    /// Time elapsed since an arbitrary fixed origin.
    func now() -> Duration
    /// Sleeps for `duration`; throws `CancellationError` when the task is cancelled.
    func sleep(for duration: Duration) async throws
}

public struct SystemLinkClock: LinkClock {
    private let clock = ContinuousClock()
    private let origin: ContinuousClock.Instant

    public init() { origin = clock.now }

    public func now() -> Duration { clock.now - origin }

    public func sleep(for duration: Duration) async throws {
        try await clock.sleep(for: duration)
    }
}

/// Random bytes for ephemeral keys, nonces and fresh device tokens.
public protocol LinkRandom: Sendable {
    func bytes(_ count: Int) -> Data
}

public struct SystemLinkRandom: LinkRandom {
    public init() {}

    public func bytes(_ count: Int) -> Data {
        // libsodium's randombytes_buf uses the OS CSPRNG (arc4random_buf on Apple platforms).
        guard let data = try? NaCl.randomBytes(count) else {
            preconditionFailure("libsodium failed to initialise; no random source")
        }
        return data
    }
}

struct DeadlineExceeded: Error {}

private enum DeadlineOutcome<T: Sendable>: Sendable {
    case value(T)
    case expired
}

/// Runs `operation` and fails with `DeadlineExceeded` after `duration`.
/// `onTimeout` runs before the operation is cancelled; it must unblock work
/// that does not observe cancellation (closing a socket, for example).
func withDeadline<T: Sendable>(
    _ duration: Duration,
    clock: any LinkClock,
    onTimeout: @escaping @Sendable () async -> Void = {},
    operation: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: DeadlineOutcome<T>.self) { group in
        group.addTask { .value(try await operation()) }
        group.addTask {
            try await clock.sleep(for: duration)
            return .expired
        }
        defer { group.cancelAll() }
        switch try await group.next()! {
        case .value(let value):
            return value
        case .expired:
            await onTimeout()
            throw DeadlineExceeded()
        }
    }
}
