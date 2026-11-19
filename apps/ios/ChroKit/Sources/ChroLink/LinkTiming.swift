import Foundation

/// The phone's timing values (spec §4.3).
public struct LinkTiming: Sendable, Equatable {
    /// TCP + WebSocket upgrade.
    public var connectDeadline: Duration = .seconds(12)
    /// Socket open to `e2ee_authenticated`.
    public var handshakeDeadline: Duration = .seconds(10)
    /// Default per-request timeout.
    public var requestTimeout: Duration = .seconds(30)
    /// `runtime.clientCapabilities.update` right after connecting.
    public var capabilitiesTimeout: Duration = .seconds(5)
    /// Consecutive rejections before giving up with `authFailed`.
    public var maxRejections = 3
    public var liveness = LivenessPolicy()
    public var reconnect = ReconnectSchedule()

    public init() {}
}

/// Delays between connection attempts: 0.5, 1, 2, 4, 8, 15, 30, 60 s, then 60 s
/// until the twelfth failure and 90 s after it. Restarts after authentication.
public struct ReconnectSchedule: Sendable, Equatable {
    public var steps: [Duration] = [.milliseconds(500), .seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(15), .seconds(30), .seconds(60)]
    public var slowAfterFailures = 12
    public var slowDelay: Duration = .seconds(90)

    public init() {}

    /// The wait after the `failures`-th consecutive failed attempt (1-based).
    public func delay(afterFailures failures: Int) -> Duration {
        precondition(failures >= 1, "delay is asked after a failure")
        if failures > slowAfterFailures { return slowDelay }
        return steps[min(failures, steps.count) - 1]
    }
}

/// When to probe a quiet connection with `status.get {probe:true}` and when to give up on it.
public struct LivenessPolicy: Sendable, Equatable {
    /// Probe after this long without receiving anything.
    public var idle: Duration = .seconds(20)
    public var probeTimeout: Duration = .seconds(8)
    public var maxFailures = 3
    /// Returning from the background or a network change: one short probe decides.
    public var urgentProbeTimeout: Duration = .seconds(4)
    public var urgentMaxFailures = 1

    public init() {}
}

/// Watches one channel: probes after `idle` silence and closes it after
/// `maxFailures` unanswered probes in a row. A probe that times out leaves the
/// link still silent, so the next probe follows at once.
actor LivenessWatchdog {
    typealias LastReceived = @Sendable () async -> Duration
    typealias Probe = @Sendable (Duration) async -> Bool
    typealias Fail = @Sendable () async -> Void

    private let policy: LivenessPolicy
    private let clock: any LinkClock
    private let lastReceived: LastReceived
    private let probe: Probe
    private let fail: Fail
    private var failed = false

    init(policy: LivenessPolicy, clock: any LinkClock, lastReceived: @escaping LastReceived, probe: @escaping Probe, fail: @escaping Fail) {
        self.policy = policy
        self.clock = clock
        self.lastReceived = lastReceived
        self.probe = probe
        self.fail = fail
    }

    /// Runs until the link fails or the task is cancelled.
    func run() async {
        var failures = 0
        while !Task.isCancelled, !failed {
            let silence = clock.now() - (await lastReceived())
            if silence < policy.idle {
                guard (try? await clock.sleep(for: policy.idle - silence)) != nil else { return }
                continue
            }
            if await probe(policy.probeTimeout) {
                failures = 0
            } else if !Task.isCancelled {
                failures += 1
                if failures >= policy.maxFailures {
                    await giveUp()
                    return
                }
            }
        }
    }

    /// Back from the background or the network changed: a short probe right away.
    func checkNow() async {
        var failures = 0
        while !failed, failures < policy.urgentMaxFailures {
            if await probe(policy.urgentProbeTimeout) { return }
            failures += 1
        }
        await giveUp()
    }

    private func giveUp() async {
        guard !failed else { return }
        failed = true
        await fail()
    }
}
