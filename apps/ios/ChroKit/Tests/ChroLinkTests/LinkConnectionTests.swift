import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// Connecting, handshake outcomes, deadlines, the reconnect schedule and the
/// rejection counter, against the in-process desktop.
struct LinkConnectionTests {
    @Test func connectsAuthenticatesAndNegotiatesTheApiGeneration() async throws {
        let harness = LinkHarness()
        try await harness.connect()
        let responder = harness.responder
        #expect(harness.connector.connectedURLs == [LinkHarness.endpoint])
        #expect(responder.isAuthenticated)
        #expect(responder.authenticatedToken == FakeResponder.ticket)
        try await eventually("capabilities update") { !responder.requests.isEmpty }
        let first = responder.requests[0]
        #expect(first.method == "runtime.clientCapabilities.update")
        #expect(first.params == Data("{\"apiGeneration\":1,\"clientCapabilities\":[\"stream.message-parts.v1\"]}".utf8))
        #expect(first.keyOrder == ["id", "deviceToken", "method", "params"])
        #expect(first.deviceToken == FakeResponder.ticket)
        #expect(responder.violations.isEmpty)
        await harness.link.stop()
    }

    @Test func failedCapabilitiesUpdateClosesAndRetries() async throws {
        let harness = LinkHarness { attempt in
            FakeResponder { request in
                attempt == 1 && request.method == "runtime.clientCapabilities.update" ? .error(code: "invalid_argument", message: "no") : .standard
            }
        }
        await harness.link.start()
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        let first = harness.responder
        try await eventually("first connection closed") { first.closedByPhone != nil }
        harness.clock.advance(by: .milliseconds(500))
        try await harness.waitFor(.connected)
        #expect(harness.connector.attempts == 2)
        await harness.link.stop()
    }

    @Test func silentCapabilitiesUpdateTimesOutAfterFiveSecondsAndRetries() async throws {
        let harness = LinkHarness { attempt in
            FakeResponder { request in attempt == 1 && request.method == "runtime.clientCapabilities.update" ? .silence : .standard }
        }
        await harness.link.start()
        try await harness.clock.waitForSleep(.seconds(5))
        #expect(await harness.link.state == .connecting(attempt: 1))
        harness.clock.advance(by: .seconds(5))
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        harness.clock.advance(by: .milliseconds(500))
        try await harness.waitFor(.connected)
        await harness.link.stop()
    }

    @Test func callsWaitUntilTheCapabilitiesUpdateSucceeds() async throws {
        let harness = LinkHarness { _ in
            FakeResponder(handler: { $0.method == "runtime.clientCapabilities.update" ? .silence : .standard }, routes: { _ in .json(status: 200, "{}") })
        }
        let link = harness.link
        await link.start()
        let call = Task { try await link.send(RawRequest(path: "/rpc/projects")) }
        let events = await link.subscribe(stream: "/streams/tasks")
        let connector = harness.connector
        try await eventually("capabilities sent") { connector.responders.last?.requests("runtime.clientCapabilities.update").isEmpty == false }
        let responder = harness.responder
        try await Task.sleep(for: .milliseconds(50))
        #expect(responder.requests.map(\.method) == ["runtime.clientCapabilities.update"])
        #expect(await link.state == .connecting(attempt: 1))
        try await responder.respond(id: responder.requests[0].id, result: "{\"apiGeneration\":1,\"capabilities\":[]}")
        #expect(try await call.value == .json(status: 200, body: Data("{}".utf8)))
        var iterator = events.makeAsyncIterator()
        #expect(try await iterator.next() == .started)
        #expect(responder.violations.isEmpty)
        await link.stop()
    }

    @Test func otherApiGenerationIsTerminal() async throws {
        let harness = LinkHarness { _ in
            FakeResponder { request in
                request.method == "runtime.clientCapabilities.update" ? .error(code: "incompatible_api", message: "apiGeneration 2") : .standard
            }
        }
        await harness.link.start()
        try await harness.waitFor(.incompatible)
        await #expect(throws: LinkError.incompatibleAPI) { try await harness.link.request("status.get") }
        #expect(harness.connector.attempts == 1)
    }

    // MARK: Rejections

    @Test func pinnedKeyMismatchIsARejection() async throws {
        var timing = LinkTiming()
        timing.maxRejections = 1
        let other = try NaCl.publicKey(secretKey: Data(repeating: 0x42, count: 32))
        let harness = LinkHarness(pinned: other, timing: timing, connector: FakeConnector(responder: { _ in FakeResponder() }))
        await harness.link.start()
        try await harness.waitFor(.authFailed)
        let responder = harness.responder
        // The phone stopped before sending auth, with an invalid-handshake close.
        #expect(!responder.isAuthenticated)
        #expect(responder.violations == ["auth frame does not open"] || responder.violations.isEmpty)
        try await eventually("phone closed 4001") { responder.closedByPhone?.code == 4001 }
    }

    @Test(arguments: [
        RejectionCase("e2ee_error unauthorized", .rejectAuth(code: "unauthorized")),
        RejectionCase("e2ee_error device_revoked", .rejectAuth(code: "device_revoked")),
        RejectionCase("authenticated with another transcript", .wrongAuthenticatedHash),
        RejectionCase("binary instead of ready", .binaryInsteadOfReady),
        RejectionCase("host closes 4001 after hello", .closeAfterHello(code: 4001, reason: "Invalid handshake message")),
        RejectionCase("ready with extra key", .mutateReady { $0["extra"] = true }),
        RejectionCase("ready without echo", .mutateReady { $0["clientNonceB64"] = Data(count: 32).base64EncodedString() }),
    ])
    func handshakeFailuresAreRejections(_ rejection: RejectionCase) async throws {
        var timing = LinkTiming()
        timing.maxRejections = 1
        let harness = LinkHarness(timing: timing) { _ in FakeResponder(behavior: rejection.behavior) }
        await harness.link.start()
        try await harness.waitFor(.authFailed)
        #expect(harness.connector.attempts == 1)
    }

    @Test func unknownTokenIsRejectedByTheHost() async throws {
        var timing = LinkTiming()
        timing.maxRejections = 1
        let harness = LinkHarness(token: "f".padding(toLength: 48, withPad: "f", startingAt: 0), timing: timing, connector: FakeConnector(responder: { _ in FakeResponder() }))
        await harness.link.start()
        try await harness.waitFor(.authFailed)
    }

    @Test func threeRejectionsInARowStopReconnecting() async throws {
        let harness = LinkHarness { _ in FakeResponder(behavior: .rejectAuth(code: "unauthorized")) }
        await harness.link.start()
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        harness.clock.advance(by: .milliseconds(500))
        try await harness.waitFor(.waiting(failures: 2, delay: .seconds(1)))
        harness.clock.advance(by: .seconds(1))
        try await harness.waitFor(.authFailed)
        #expect(harness.connector.attempts == 3)
        await #expect(throws: LinkError.authFailed) { try await harness.link.request("status.get") }
    }

    @Test func aGoodSessionResetsTheRejectionCount() async throws {
        // reject, reject, accept (then the host drops it), reject, reject: still not auth-failed.
        let harness = LinkHarness { attempt in
            FakeResponder(behavior: attempt == 3 ? .honest : .rejectAuth(code: "unauthorized"))
        }
        await harness.link.start()
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        harness.clock.advance(by: .milliseconds(500))
        try await harness.waitFor(.waiting(failures: 2, delay: .seconds(1)))
        harness.clock.advance(by: .seconds(1))
        try await harness.waitFor(.connected)
        harness.responder.close(code: 1001, reason: "Going away")
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        harness.clock.advance(by: .milliseconds(500))
        try await harness.waitFor(.waiting(failures: 2, delay: .seconds(1)))
        harness.clock.advance(by: .seconds(1))
        try await harness.waitFor(.waiting(failures: 3, delay: .seconds(2)))
        #expect(harness.connector.attempts == 5)
        await harness.link.stop()
    }

    @Test func unauthorizedAnswerClosesTheConnectionAndCountsARejection() async throws {
        var timing = LinkTiming()
        timing.maxRejections = 2
        let harness = LinkHarness(timing: timing) { attempt in
            FakeResponder(behavior: attempt == 1 ? .honest : .rejectAuth(code: "device_revoked")) { request in
                request.method == "session.secret" ? .error(code: "unauthorized", message: "Device token mismatch") : .standard
            }
        }
        try await harness.connect()
        let first = harness.responder
        await #expect(throws: LinkError.rpc(RPCError(code: "unauthorized", message: "Device token mismatch"))) {
            try await harness.link.request("session.secret")
        }
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        #expect(first.closedByPhone != nil)
        harness.clock.advance(by: .milliseconds(500))
        // The second rejection in a row (at the handshake) reaches the limit of 2.
        try await harness.waitFor(.authFailed)
    }

    // MARK: Transport failures and deadlines

    @Test func networkCloseBeforeReadyIsNotARejection() async throws {
        var timing = LinkTiming()
        timing.maxRejections = 1
        let harness = LinkHarness(timing: timing) { _ in FakeResponder(behavior: .closeAfterHello(code: 1006, reason: "")) }
        await harness.link.start()
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        await harness.link.stop()
    }

    @Test func connectDeadlineIsTwelveSeconds() async throws {
        let harness = LinkHarness(connector: FakeConnector { attempt in attempt == 1 ? .hang : .accept(FakeResponder()) })
        await harness.link.start()
        try await harness.clock.waitForSleep(.seconds(12))
        harness.clock.advance(by: .milliseconds(11_999))
        #expect(await harness.link.state == .connecting(attempt: 1))
        harness.clock.advance(by: .milliseconds(1))
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        harness.clock.advance(by: .milliseconds(500))
        try await harness.waitFor(.connected)
        await harness.link.stop()
    }

    @Test func handshakeDeadlineIsTenSecondsAndNotARejection() async throws {
        var timing = LinkTiming()
        timing.maxRejections = 1
        let harness = LinkHarness(timing: timing) { _ in FakeResponder(behavior: .silentAfterHello) }
        await harness.link.start()
        try await harness.clock.waitForSleep(.seconds(10))
        harness.clock.advance(by: .seconds(10))
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        let responder = harness.responder
        try await eventually("phone closed 4002") { responder.closedByPhone?.code == 4002 }
        await harness.link.stop()
    }

    @Test func handshakeDeadlineCoversTheAuthAnswerToo() async throws {
        let harness = LinkHarness { _ in FakeResponder(behavior: .silentAfterAuth) }
        await harness.link.start()
        try await harness.clock.waitForSleep(.seconds(10))
        try await eventually("auth sent") { harness.connector.responders.count == 1 }
        harness.clock.advance(by: .seconds(10))
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        await harness.link.stop()
    }

    @Test func reconnectScheduleFollowsTheSpec() async throws {
        let harness = LinkHarness(connector: FakeConnector { _ in .refuse })
        await harness.link.start()
        let expected: [Duration] = [.milliseconds(500), .seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(15), .seconds(30), .seconds(60), .seconds(60), .seconds(60), .seconds(60), .seconds(60), .seconds(90), .seconds(90), .seconds(90)]
        for (index, delay) in expected.enumerated() {
            try await harness.waitFor(.waiting(failures: index + 1, delay: delay))
            harness.clock.advance(by: delay - .milliseconds(1))
            #expect(await harness.link.state == .waiting(failures: index + 1, delay: delay))
            harness.clock.advance(by: .milliseconds(1))
        }
        try await harness.waitFor(.waiting(failures: 16, delay: .seconds(90)))
        #expect(harness.connector.attempts == 16)
        await harness.link.stop()
    }

    @Test func authenticationRestartsTheSchedule() async throws {
        let harness = LinkHarness(connector: FakeConnector { attempt in attempt <= 3 ? .refuse : .accept(FakeResponder()) })
        await harness.link.start()
        for (failures, delay) in [(1, Duration.milliseconds(500)), (2, .seconds(1)), (3, .seconds(2))] {
            try await harness.waitFor(.waiting(failures: failures, delay: delay))
            harness.clock.advance(by: delay)
        }
        try await harness.waitFor(.connected)
        harness.responder.close(code: 1001, reason: "Going away")
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        await harness.link.stop()
    }

    @Test func connectionChangeSkipsTheWait() async throws {
        let harness = LinkHarness(connector: FakeConnector { attempt in attempt == 1 ? .refuse : .accept(FakeResponder()) })
        await harness.link.start()
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        await harness.link.connectionMayHaveChanged()
        try await harness.waitFor(.connected)
        await harness.link.stop()
    }

    @Test func stopFailsPendingCallsAndClosesTheSocket() async throws {
        let harness = LinkHarness { _ in FakeResponder { request in request.method == "slow" ? .silence : .standard } }
        try await harness.connect()
        let link = harness.link
        let call = Task { try await link.request("slow") }
        try await eventually("slow sent") { !harness.responder.requests("slow").isEmpty }
        await link.stop()
        await #expect(throws: LinkError.self) { try await call.value }
        #expect(await link.state == .stopped)
        let responder = harness.responder
        try await eventually("socket closed") { responder.closedByPhone != nil }
        await #expect(throws: LinkError.stopped) { try await link.request("status.get") }
    }

    @Test func statesStreamReportsTheSequence() async throws {
        let harness = LinkHarness(connector: FakeConnector { attempt in attempt == 1 ? .refuse : .accept(FakeResponder()) })
        let states = await harness.link.states()
        await harness.link.start()
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        harness.clock.advance(by: .milliseconds(500))
        try await harness.waitFor(.connected)
        await harness.link.stop()
        var seen: [ChroLink.State] = []
        for await state in states { seen.append(state) }
        #expect(seen == [.idle, .connecting(attempt: 1), .waiting(failures: 1, delay: .milliseconds(500)), .connecting(attempt: 2), .connected, .stopped])
    }
}

struct RejectionCase: Sendable, CustomTestStringConvertible {
    let name: String
    let behavior: FakeResponder.HandshakeBehavior

    init(_ name: String, _ behavior: FakeResponder.HandshakeBehavior) {
        self.name = name
        self.behavior = behavior
    }

    var testDescription: String { name }
}
