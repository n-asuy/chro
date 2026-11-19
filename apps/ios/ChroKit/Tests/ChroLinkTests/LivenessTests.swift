import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// The liveness watchdog: 20 s of silence → `status.get {probe:true}` with 8 s,
/// three failures close; a connection change probes once with 4 s.
struct LivenessTests {
    private func probes(_ responder: FakeResponder) -> Int {
        responder.requests("status.get").filter { $0.paramsObject["probe"] as? Bool == true }.count
    }

    private static func ignoringProbes() -> LinkHarness {
        LinkHarness { _ in
            FakeResponder { request in
                request.method == "status.get" && request.paramsObject["probe"] as? Bool == true ? .silence : .standard
            }
        }
    }

    @Test func quietLinkIsProbedEveryTwentySeconds() async throws {
        let harness = LinkHarness()
        try await harness.connect()
        let responder = harness.responder
        try await harness.clock.waitForSleep(.seconds(20))
        harness.clock.advance(by: .milliseconds(19_999))
        #expect(probes(responder) == 0)
        harness.clock.advance(by: .milliseconds(1))
        try await eventually("first probe") { self.probes(responder) == 1 }
        // Answered: the next probe follows another 20 s of silence.
        try await eventually("watchdog asleep again") { harness.clock.pending == [.seconds(20)] }
        harness.clock.advance(by: .seconds(20))
        try await eventually("second probe") { self.probes(responder) == 2 }
        #expect(await harness.link.state == .connected)
        await harness.link.stop()
    }

    @Test func threeUnansweredProbesCloseTheConnection() async throws {
        let harness = Self.ignoringProbes()
        try await harness.connect()
        let responder = harness.responder
        try await harness.clock.waitForSleep(.seconds(20))
        harness.clock.advance(by: .seconds(20))
        for probe in 1...3 {
            try await eventually("probe \(probe)") { self.probes(responder) == probe }
            try await harness.clock.waitForSleep(.seconds(8))
            #expect(await harness.link.state == .connected)
            harness.clock.advance(by: .seconds(8))
        }
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        try await eventually("phone closed") { responder.closedByPhone != nil }
        await harness.link.stop()
    }

    @Test func trafficPostponesTheProbe() async throws {
        let harness = LinkHarness()
        try await harness.connect()
        let responder = harness.responder
        try await harness.clock.waitForSleep(.seconds(20))
        harness.clock.advance(by: .seconds(15))
        _ = try await harness.link.request("status.get")
        harness.clock.advance(by: .seconds(5))
        // Woken at 20 s, but the last answer came at 15 s: it sleeps the remaining 15 s.
        try await harness.clock.waitForSleep(.seconds(15))
        #expect(probes(responder) == 0)
        harness.clock.advance(by: .seconds(15))
        try await eventually("probe") { self.probes(responder) == 1 }
        await harness.link.stop()
    }

    @Test func connectionChangeProbesOnceWithFourSeconds() async throws {
        let harness = Self.ignoringProbes()
        try await harness.connect()
        let link = harness.link
        let check = Task { await link.connectionMayHaveChanged() }
        let responder = harness.responder
        try await eventually("urgent probe") { self.probes(responder) == 1 }
        try await harness.clock.waitForSleep(.seconds(4))
        harness.clock.advance(by: .seconds(4))
        await check.value
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        await link.stop()
    }

    @Test func answeredConnectionChangeProbeKeepsTheLink() async throws {
        let harness = LinkHarness()
        try await harness.connect()
        await harness.link.connectionMayHaveChanged()
        #expect(probes(harness.responder) == 1)
        #expect(await harness.link.state == .connected)
        await harness.link.stop()
    }

    @Test func errorAnswerToAProbeStillProvesLiveness() async throws {
        let harness = LinkHarness { _ in
            FakeResponder { $0.method == "status.get" ? .error(code: "runtime_busy", message: "busy") : .standard }
        }
        try await harness.connect()
        await harness.link.connectionMayHaveChanged()
        #expect(await harness.link.state == .connected)
        await harness.link.stop()
    }
}

/// The pure schedule values.
struct ReconnectScheduleTests {
    @Test func delays() {
        let schedule = ReconnectSchedule()
        let seconds = (1...15).map { schedule.delay(afterFailures: $0) }
        #expect(seconds == [.milliseconds(500), .seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(15), .seconds(30), .seconds(60), .seconds(60), .seconds(60), .seconds(60), .seconds(60), .seconds(90), .seconds(90), .seconds(90)])
    }

    @Test func timingDefaultsAreTheSpecValues() {
        let timing = LinkTiming()
        #expect(timing.connectDeadline == .seconds(12))
        #expect(timing.handshakeDeadline == .seconds(10))
        #expect(timing.requestTimeout == .seconds(30))
        #expect(timing.capabilitiesTimeout == .seconds(5))
        #expect(timing.maxRejections == 3)
        #expect(timing.liveness.idle == .seconds(20))
        #expect(timing.liveness.probeTimeout == .seconds(8))
        #expect(timing.liveness.maxFailures == 3)
        #expect(timing.liveness.urgentProbeTimeout == .seconds(4))
        #expect(timing.liveness.urgentMaxFailures == 1)
    }
}
