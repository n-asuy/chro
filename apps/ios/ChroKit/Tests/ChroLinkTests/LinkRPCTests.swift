import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// Requests, timeouts, streams, unsubscribe, binary frames and the strict
/// inbound counters, once connected.
struct LinkRPCTests {
    @Test func requestIdsAreUniqueAndCarryTheToken() async throws {
        let harness = LinkHarness()
        try await harness.connect()
        let first = try await harness.link.request("status.get")
        let status = try JSONSerialization.jsonObject(with: first) as? [String: Any]
        #expect(status?["machineName"] as? String == "studio")
        _ = try await harness.link.request("status.get", params: Data("{\"probe\":false}".utf8))
        let requests = harness.responder.requests
        let ids = requests.map(\.id)
        #expect(Set(ids).count == ids.count)
        for (index, id) in ids.enumerated() {
            let parts = id.split(separator: "-")
            #expect(parts.count == 3 && parts[0] == "rpc" && Int(parts[1]) == index + 1 && Int64(parts[2]) != nil, "\(id)")
        }
        #expect(requests.allSatisfy { $0.deviceToken == FakeResponder.ticket && $0.keyOrder == ["id", "deviceToken", "method", "params"] })
        #expect(requests.last?.paramsObject["probe"] as? Bool == false)
        await harness.link.stop()
    }

    @Test func typedRequestEncodesParamsAndDecodesTheResult() async throws {
        struct Probe: Encodable, Sendable { let probe: Bool }
        struct Status: Decodable, Sendable, Equatable {
            let capabilities: [String]
            let machineName: String
        }
        let harness = LinkHarness()
        try await harness.connect()
        let status = try await harness.link.request("status.get", params: Probe(probe: true), as: Status.self)
        #expect(status == Status(capabilities: [FakeResponder.ticketExchangeCapability], machineName: "studio"))
        await harness.link.stop()
    }

    @Test func errorAnswersSurfaceAsRPCErrors() async throws {
        let harness = LinkHarness()
        try await harness.connect()
        await #expect(throws: LinkError.rpc(RPCError(code: "method_not_found", message: "no method nope"))) {
            try await harness.link.request("nope")
        }
        #expect(await harness.link.state == .connected)
        await harness.link.stop()
    }

    @Test func requestTimesOutAfterThirtySecondsAndTheLinkStays() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "slow" ? .silence : .standard } }
        try await harness.connect()
        let link = harness.link
        let call = Task { try await link.request("slow") }
        try await eventually("slow sent") { !harness.responder.requests("slow").isEmpty }
        try await harness.clock.waitForSleep(.seconds(30))
        harness.clock.advance(by: .seconds(29))
        harness.clock.advance(by: .seconds(1))
        await #expect(throws: LinkError.timeout) { try await call.value }
        #expect(await link.state == .connected)
        await link.stop()
    }

    @Test func callerSuppliedTimeout() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "slow" ? .silence : .standard } }
        try await harness.connect()
        let link = harness.link
        let call = Task { try await link.request("slow", timeout: .seconds(3)) }
        try await harness.clock.waitForSleep(.seconds(3))
        harness.clock.advance(by: .seconds(3))
        await #expect(throws: LinkError.timeout) { try await call.value }
        await link.stop()
    }

    @Test func requestWaitsForTheConnection() async throws {
        let harness = LinkHarness(connector: FakeConnector { attempt in attempt == 1 ? .refuse : .accept(FakeResponder()) })
        let link = harness.link
        let call = Task { try await link.request("status.get") }
        await link.start()
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        harness.clock.advance(by: .milliseconds(500))
        _ = try await call.value
        await link.stop()
    }

    @Test func waitingForTheConnectionCountsTowardsTheTimeout() async throws {
        let harness = LinkHarness(connector: FakeConnector { _ in .refuse })
        let link = harness.link
        await link.start()
        let call = Task { try await link.request("status.get") }
        try await harness.clock.waitForSleep(.seconds(30))
        harness.clock.advance(by: .seconds(30))
        await #expect(throws: LinkError.timeout) { try await call.value }
        await link.stop()
    }

    @Test func droppedConnectionFailsCallsInFlight() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "slow" ? .silence : .standard } }
        try await harness.connect()
        let link = harness.link
        let call = Task { try await link.request("slow") }
        try await eventually("slow sent") { !harness.responder.requests("slow").isEmpty }
        harness.responder.close(code: 1001, reason: "Going away")
        await #expect(throws: LinkError.disconnected) { try await call.value }
        await link.stop()
    }

    // MARK: Streams

    @Test func subscriptionDeliversUntilEndAndUsesTheStreamEnvelope() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "subscribe" ? .silence : .standard } }
        try await harness.connect()
        let events = await harness.link.subscribe(stream: "/streams/tasks/:task_id/runs", params: Data("{\"task_id\":\"t1\"}".utf8))
        let responder = harness.responder
        try await eventually("subscribe sent") { !responder.requests("subscribe").isEmpty }
        let request = responder.requests("subscribe")[0]
        #expect(request.paramsObject["stream"] as? String == "/streams/tasks/:task_id/runs")
        #expect((request.paramsObject["params"] as? [String: String]) == ["task_id": "t1"])
        try await responder.respond(id: request.id, result: "{\"type\":\"ready\",\"subscriptionId\":\"sub-1\"}", streaming: true)
        try await responder.respond(id: request.id, result: "{\"type\":\"message\",\"subscriptionId\":\"sub-1\",\"data\":{\"JsonPatch\":[]}}", streaming: true)
        try await responder.respond(id: request.id, result: "{\"type\":\"message\",\"subscriptionId\":\"sub-1\",\"data\":{\"finished\":true}}", streaming: true)
        try await responder.respond(id: request.id, result: "{\"type\":\"end\",\"subscriptionId\":\"sub-1\"}", streaming: true)
        var seen: [StreamEvent] = []
        for try await event in events { seen.append(event) }
        #expect(seen == [.started, .message(Data("{\"JsonPatch\":[]}".utf8)), .message(Data("{\"finished\":true}".utf8))])
        await harness.link.stop()
    }

    @Test func subscriptionErrorEndsTheStream() async throws {
        let harness = LinkHarness { _ in
            FakeResponder { $0.method == "subscribe" ? .error(code: "forbidden", message: "not allowed") : .standard }
        }
        try await harness.connect()
        let events = await harness.link.subscribe(stream: "/streams/developer")
        await #expect(throws: LinkError.rpc(RPCError(code: "forbidden", message: "not allowed"))) {
            for try await _ in events {}
        }
        await harness.link.stop()
    }

    @Test func endingTheIterationUnsubscribes() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "subscribe" ? .silence : .standard } }
        try await harness.connect()
        let link = harness.link
        // The consumer owns the stream, as a view's task does; leaving the loop releases it.
        let consumer = Task { () -> StreamEvent? in
            for try await event in await link.subscribe(stream: "/streams/tasks") {
                if case .message = event { return event }
            }
            return nil
        }
        let responder = harness.responder
        try await eventually("subscribe sent") { !responder.requests("subscribe").isEmpty }
        let id = responder.requests("subscribe")[0].id
        try await responder.respond(id: id, result: "{\"type\":\"ready\",\"subscriptionId\":\"sub-9\"}", streaming: true)
        try await responder.respond(id: id, result: "{\"type\":\"message\",\"subscriptionId\":\"sub-9\",\"data\":1}", streaming: true)
        #expect(try await consumer.value == .message(Data("1".utf8)))
        try await eventually("unsubscribe sent") { !responder.requests("subscribe.unsubscribe").isEmpty }
        #expect(responder.requests("subscribe.unsubscribe")[0].paramsObject["subscriptionId"] as? String == "sub-9")
        await harness.link.stop()
    }

    @Test func cancellingTheConsumerUnsubscribes() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "subscribe" ? .silence : .standard } }
        try await harness.connect()
        let link = harness.link
        let consumer = Task {
            for try await _ in await link.subscribe(stream: "/streams/tasks") {}
        }
        let responder = harness.responder
        try await eventually("subscribe sent") { !responder.requests("subscribe").isEmpty }
        try await responder.respond(id: responder.requests("subscribe")[0].id, result: "{\"type\":\"ready\",\"subscriptionId\":\"sub-3\"}", streaming: true)
        try await eventually("subscription id known") { await link.subscriptionIds == ["sub-3"] }
        consumer.cancel()
        try await eventually("unsubscribe sent") { !responder.requests("subscribe.unsubscribe").isEmpty }
        #expect(responder.requests("subscribe.unsubscribe")[0].paramsObject["subscriptionId"] as? String == "sub-3")
        #expect(await link.subscriptionIds.isEmpty)
        await harness.link.stop()
    }

    /// A reader that leaves while the subscribe is in flight: the host's subscription
    /// is released when its `ready` arrives, so the host does not stream to nobody.
    @Test func cancellingBeforeReadyReleasesTheHostsSubscriptionWhenItIsReady() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "subscribe" ? .silence : .standard } }
        try await harness.connect()
        let link = harness.link
        let consumer = Task {
            for try await _ in await link.subscribe(stream: "/streams/tasks") {}
        }
        let responder = harness.responder
        try await eventually("subscribe sent") { !responder.requests("subscribe").isEmpty }
        consumer.cancel()
        _ = await consumer.result
        try await responder.respond(id: responder.requests("subscribe")[0].id, result: "{\"type\":\"ready\",\"subscriptionId\":\"sub-7\"}", streaming: true)
        try await eventually("unsubscribe sent") { !responder.requests("subscribe.unsubscribe").isEmpty }
        #expect(responder.requests("subscribe.unsubscribe")[0].paramsObject["subscriptionId"] as? String == "sub-7")
        #expect(await link.subscriptionIds.isEmpty)
        await harness.link.stop()
    }

    @Test func subscriptionsSurviveReconnects() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "subscribe" ? .silence : .standard } }
        try await harness.connect()
        let events = await harness.link.subscribe(stream: "/streams/tasks")
        let first = harness.responder
        try await eventually("subscribe sent") { !first.requests("subscribe").isEmpty }
        try await first.respond(id: first.requests("subscribe")[0].id, result: "{\"type\":\"ready\",\"subscriptionId\":\"a\"}", streaming: true)
        try await first.respond(id: first.requests("subscribe")[0].id, result: "{\"type\":\"message\",\"subscriptionId\":\"a\",\"data\":\"one\"}", streaming: true)
        var iterator = events.makeAsyncIterator()
        #expect(try await iterator.next() == .started)
        #expect(try await iterator.next() == .message(Data("\"one\"".utf8)))

        first.close(code: 1001, reason: "Going away")
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        harness.clock.advance(by: .milliseconds(500))
        try await harness.waitFor(.connected)
        let second = harness.responder
        #expect(second !== first)
        try await eventually("resubscribed") { !second.requests("subscribe").isEmpty }
        #expect(second.requests("subscribe")[0].paramsObject["stream"] as? String == "/streams/tasks")
        try await second.respond(id: second.requests("subscribe")[0].id, result: "{\"type\":\"ready\",\"subscriptionId\":\"b\"}", streaming: true)
        try await second.respond(id: second.requests("subscribe")[0].id, result: "{\"type\":\"message\",\"subscriptionId\":\"b\",\"data\":\"two\"}", streaming: true)
        #expect(try await iterator.next() == .started)
        #expect(try await iterator.next() == .message(Data("\"two\"".utf8)))
        await harness.link.stop()
        await #expect(throws: LinkError.stopped) { _ = try await iterator.next() }
    }

    // MARK: Strict inbound counters

    /// Subscribes and returns the responder and the subscribe request id once `.started` arrived.
    private func streaming(_ harness: LinkHarness) async throws -> (FakeResponder, String, LinkSubscription.Iterator) {
        try await harness.connect()
        var iterator = await harness.link.subscribe(stream: "/streams/tasks").makeAsyncIterator()
        let responder = harness.responder
        try await eventually("subscribe sent") { !responder.requests("subscribe").isEmpty }
        let id = responder.requests("subscribe")[0].id
        try await responder.respond(id: id, result: "{\"type\":\"ready\",\"subscriptionId\":\"s\"}", streaming: true)
        #expect(try await iterator.next() == .started)
        return (responder, id, iterator)
    }

    private func dataFrame(_ id: String, _ value: String) -> Data {
        Data("{\"id\":\"\(id)\",\"ok\":true,\"result\":{\"type\":\"message\",\"subscriptionId\":\"s\",\"data\":\"\(value)\"},\"streaming\":true}".utf8)
    }

    @Test func replayedFrameIsIgnored() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "subscribe" ? .silence : .standard } }
        let (responder, id, start) = try await streaming(harness)
        var iterator = start
        let a = responder.seal(kind: .text, payload: dataFrame(id, "a"))
        try await responder.sendRaw(.text(a.base64EncodedString()))
        try await responder.sendRaw(.text(a.base64EncodedString()))  // replay
        try await responder.sendSealed(dataFrame(id, "b"))
        #expect(try await iterator.next() == .message(Data("\"a\"".utf8)))
        #expect(try await iterator.next() == .message(Data("\"b\"".utf8)))
        #expect(await harness.link.state == .connected)
        await harness.link.stop()
    }

    @Test func aGapStopsEverythingAfterItAndFiveFailuresClose() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "subscribe" ? .silence : .standard } }
        let (responder, id, start) = try await streaming(harness)
        var iterator = start
        try await responder.sendSealed(dataFrame(id, "a"))
        _ = responder.seal(kind: .text, payload: dataFrame(id, "lost"))  // never sent
        for value in ["b", "c", "d", "e", "f"] { try await responder.sendSealed(dataFrame(id, value)) }
        #expect(try await iterator.next() == .message(Data("\"a\"".utf8)))
        try await eventually("closed 4003") { responder.closedByPhone?.code == 4003 }
        try await harness.waitFor(.waiting(failures: 1, delay: .milliseconds(500)))
        await harness.link.stop()
    }

    @Test func reflectedFramesAreRejectedAndASuccessResetsTheFailureCount() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "subscribe" ? .silence : .standard } }
        let (responder, id, start) = try await streaming(harness)
        var iterator = start
        let own = try #require(responder.framesFromPhone.first)
        for _ in 0..<4 { try await responder.sendRaw(own) }
        try await responder.sendSealed(dataFrame(id, "a"))
        for _ in 0..<4 { try await responder.sendRaw(own) }
        try await responder.sendSealed(dataFrame(id, "b"))
        #expect(try await iterator.next() == .message(Data("\"a\"".utf8)))
        #expect(try await iterator.next() == .message(Data("\"b\"".utf8)))
        #expect(await harness.link.state == .connected)
        for _ in 0..<5 { try await responder.sendRaw(own) }
        try await eventually("closed 4003") { responder.closedByPhone?.code == 4003 }
        await harness.link.stop()
    }

    @Test func kindComesFromTheOpcode() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "subscribe" ? .silence : .standard } }
        let (responder, id, start) = try await streaming(harness)
        var iterator = start
        // A text-kind frame delivered in a binary message does not open, and it does not consume the counter.
        let text = responder.seal(kind: .text, payload: dataFrame(id, "a"))
        try await responder.sendRaw(.binary(text))
        try await responder.sendRaw(.text(text.base64EncodedString()))
        #expect(try await iterator.next() == .message(Data("\"a\"".utf8)))
        // A text message that is not canonical base64 is a failure too.
        try await responder.sendRaw(.text(String(text.base64EncodedString().dropLast())))
        try await responder.sendSealed(dataFrame(id, "b"))
        #expect(try await iterator.next() == .message(Data("\"b\"".utf8)))
        await harness.link.stop()
    }

    @Test func theServersSubscriptionLifecycle() async throws {
        let harness = LinkHarness { _ in
            FakeResponder(snapshot: { subscription in
                subscription.params["task_id"] == "t1" ? ["{\"type\":\"json_patch\",\"payload\":[]}"] : []
            })
        }
        try await harness.connect()
        var iterator = await harness.link.subscribe(stream: "/streams/tasks/:task_id/runs", params: Data("{\"task_id\":\"t1\"}".utf8)).makeAsyncIterator()
        #expect(try await iterator.next() == .started)
        #expect(try await iterator.next() == .message(Data("{\"payload\":[],\"type\":\"json_patch\"}".utf8)))
        let responder = harness.responder
        let subscription = try #require(responder.subscriptions.first)
        #expect(subscription.stream == "/streams/tasks/:task_id/runs")
        try await responder.push("{\"type\":\"finished\"}", to: subscription.subscriptionId)
        #expect(try await iterator.next() == .message(Data("{\"type\":\"finished\"}".utf8)))
        try await responder.endSubscription(subscription.subscriptionId)
        #expect(try await iterator.next() == nil)
        #expect(responder.violations.isEmpty)
        await harness.link.stop()
    }

    @Test func anEndWithAnErrorFailsTheStream() async throws {
        let harness = LinkHarness()
        try await harness.connect()
        var iterator = await harness.link.subscribe(stream: "/streams/tasks").makeAsyncIterator()
        #expect(try await iterator.next() == .started)
        let responder = harness.responder
        try await responder.endSubscription(try #require(responder.subscriptions.first).subscriptionId, error: ("reply_too_large", "a stream message exceeded 4194304 bytes"))
        await #expect(throws: LinkError.rpc(RPCError(code: "reply_too_large", message: "a stream message exceeded 4194304 bytes"))) {
            _ = try await iterator.next()
        }
        await harness.link.stop()
    }

    @Test func anUnknownStreamIsNotFound() async throws {
        let harness = LinkHarness()
        try await harness.connect()
        let events = await harness.link.subscribe(stream: "/streams/browser")
        await #expect(throws: LinkError.rpc(RPCError(code: "not_found", message: "no stream /streams/browser"))) {
            for try await _ in events {}
        }
        await harness.link.stop()
    }

    /// A stream message over the host's reply cap (a real host's task list) arrives
    /// as parts (`stream.message-parts.v1`); the reader gets it whole, once.
    @Test func aMessageSentInPartsArrivesWhole() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "subscribe" ? .silence : .standard } }
        let (responder, id, start) = try await streaming(harness)
        var iterator = start
        let message = "{\"type\":\"json_patch\",\"payload\":[{\"op\":\"replace\",\"path\":\"/tasks\",\"value\":{\"t\":\"説明\\\"\"}}]}"
        let cut = message.index(message.startIndex, offsetBy: 30)
        for (text, isFinal) in [(String(message[..<cut]), false), (String(message[cut...]), true)] {
            let part = try JSONSerialization.data(withJSONObject: ["type": "part", "subscriptionId": "s", "text": text, "final": isFinal])
            try await responder.respond(id: id, result: String(decoding: part, as: UTF8.self), streaming: true)
        }
        try await responder.respond(id: id, result: "{\"type\":\"message\",\"subscriptionId\":\"s\",\"data\":1}", streaming: true)
        #expect(try await iterator.next() == .message(Data(message.utf8)))
        #expect(try await iterator.next() == .message(Data("1".utf8)))
        await harness.link.stop()
    }

    @Test func partsBeyondTheMessageLimitFailTheStream() async throws {
        var limits = LinkLimits()
        limits.streamMessageBytes = 8
        let harness = LinkHarness(limits: limits) { _ in FakeResponder { $0.method == "subscribe" ? .silence : .standard } }
        let (responder, id, start) = try await streaming(harness)
        var iterator = start
        try await responder.respond(id: id, result: "{\"type\":\"part\",\"subscriptionId\":\"s\",\"text\":\"[1,2,3\",\"final\":false}", streaming: true)
        try await responder.respond(id: id, result: "{\"type\":\"part\",\"subscriptionId\":\"s\",\"text\":\",4,5]\",\"final\":true}", streaming: true)
        await #expect(throws: LinkError.self) { _ = try await iterator.next() }
        await harness.link.stop()
    }

    @Test func aMessageForAnotherSubscriptionIsMalformed() async throws {
        let harness = LinkHarness { _ in FakeResponder { $0.method == "subscribe" ? .silence : .standard } }
        let (responder, id, start) = try await streaming(harness)
        var iterator = start
        try await responder.respond(id: id, result: "{\"type\":\"message\",\"subscriptionId\":\"other\",\"data\":1}", streaming: true)
        await #expect(throws: LinkError.self) { _ = try await iterator.next() }
        await harness.link.stop()
    }
}
