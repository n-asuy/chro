import Foundation
@testable import ChroLink

/// A link wired to an in-process desktop and a manual clock.
struct LinkHarness {
    static let endpoint = URL(string: "ws://192.168.1.23:6768")!
    static let hostSecret = Data((1...32).map { UInt8($0) &* 7 })
    static let hostPublic = try! NaCl.publicKey(secretKey: hostSecret)

    let clock = ManualClock()
    let connector: FakeConnector
    let link: ChroLink

    init(
        pinned: Data = LinkHarness.hostPublic,
        token: String = FakeResponder.ticket,
        timing: LinkTiming = LinkTiming(),
        limits: LinkLimits = LinkLimits(),
        connector: FakeConnector
    ) {
        self.connector = connector
        link = ChroLink(
            host: .init(endpoint: Self.endpoint, publicKey: pinned),
            deviceToken: token,
            connector: connector,
            clock: clock,
            random: CountingRandom(),
            timing: timing,
            limits: limits
        )
    }

    /// Every attempt is served by a fresh responder from `make`.
    init(timing: LinkTiming = LinkTiming(), limits: LinkLimits = LinkLimits(), responder make: @escaping @Sendable (Int) -> FakeResponder = { _ in FakeResponder() }) {
        self.init(timing: timing, limits: limits, connector: FakeConnector(responder: make))
    }

    var responder: FakeResponder { connector.responders.last! }

    /// Waits for `expected`; for `.waiting` also until the retry sleep is on the
    /// clock, so advancing by its delay is guaranteed to wake it.
    func waitFor(_ expected: ChroLink.State) async throws {
        let link = self.link
        try await eventually("state \(expected)") { await link.state == expected }
        if case .waiting(_, let delay) = expected {
            let clock = self.clock
            try await eventually("retry sleep of \(delay)") { clock.remaining.contains(delay) }
        }
    }

    func waitUntil(_ what: String, _ condition: @escaping @Sendable (ChroLink.State) -> Bool) async throws {
        let link = self.link
        try await eventually(what) { condition(await link.state) }
    }

    /// Starts and waits for the first connection to be published.
    func connect() async throws {
        await link.start()
        try await waitFor(.connected)
    }
}

/// Distinct deterministic bytes per call (ephemeral keys, nonces, tokens).
final class CountingRandom: LinkRandom, @unchecked Sendable {
    private let lock = NSLock()
    private var next: UInt8

    /// `start` separates the sequences of two instances in one test.
    init(start: UInt8 = 1) { next = start }

    func bytes(_ count: Int) -> Data {
        lock.withLock {
            defer { next &+= 1 }
            return Data((0..<count).map { UInt8(truncatingIfNeeded: Int(next) &* 31 &+ $0) })
        }
    }
}
