import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// The link's memory bounds under a stalled network or a slow reader: the
/// outbox (queued bytes and pending calls) with backpressure, requests that
/// expire before they are sent, and subscription buffers that start over from
/// a fresh snapshot instead of growing.
@Suite(.timeLimit(.minutes(1)))
struct LinkBackpressureTests {
    /// Starts one call and waits until the link holds it, so calls enter the outbox in order.
    private static func enqueue(_ link: ChroLink, _ method: String, _ params: String, timeout: Duration? = nil) async throws -> Task<Data, Error> {
        let before = await link.enqueuedCount
        let call = Task { try await link.request(method, params: Data(params.utf8), timeout: timeout) }
        try await eventually("\(method) \(params.prefix(8)) queued") { await link.enqueuedCount == before + 1 }
        return call
    }

    private static func silentFor(_ methods: Set<String>) -> @Sendable (Int) -> FakeResponder {
        { _ in FakeResponder { methods.contains($0.method) ? .silence : .standard } }
    }

    @Test func aRequestThatExpiresBeforeItIsSentIsNeverSealed() async throws {
        let harness = LinkHarness(responder: Self.silentFor(["slow"]))
        try await harness.connect()
        let link = harness.link
        let socket = try #require(harness.connector.clients.last)
        socket.holdSends()
        // The writer takes this one and stalls on the socket.
        let stalled = Task { try await link.request("slow", timeout: .seconds(40)) }
        try await eventually("writer stalled") { socket.stalledSends == 1 }
        let expiring = Task { try await link.request("expiring", timeout: .seconds(3)) }
        try await harness.clock.waitForSleep(.seconds(3))
        harness.clock.advance(by: .seconds(3))
        await #expect(throws: LinkError.timeout) { try await expiring.value }

        socket.releaseSends()
        // The next frame opens under the next counter: the expired request spent none.
        let status = try await link.request("status.get")
        #expect(!status.isEmpty)
        let responder = harness.responder
        #expect(responder.requests("expiring").isEmpty)
        #expect(responder.requests.map(\.method).suffix(2) == ["slow", "status.get"])
        #expect(responder.violations.isEmpty)
        stalled.cancel()
        await link.stop()
    }

    @Test func concurrentRequestsStayWithinTheHostsSlotsAndTheNextWaits() async throws {
        // The host runs at most `maxConcurrentRequests` `request`s per connection and
        // refuses more with `runtime_busy`: the phone waits for a slot instead.
        var limits = LinkLimits()
        limits.maxConcurrentRequests = 2
        let harness = LinkHarness(limits: limits, responder: Self.silentFor(["request"]))
        try await harness.connect()
        let link = harness.link
        var calls: [Task<Data, Error>] = []
        for index in 0..<3 { calls.append(try await Self.enqueue(link, "request", "{\"n\":\(index)}")) }
        let responder = harness.responder
        try await eventually("two requests sent") { responder.requests("request").count == 2 }
        #expect(await link.outboxLoad == OutboxLoad(queuedBytes: 0, requests: 2, waiting: 1))
        // Other methods (the liveness probe, unsubscribe) never wait behind requests.
        _ = try await link.request("status.get")
        // Answering one frees its slot for the third.
        try await responder.respond(id: responder.requests("request")[0].id, result: "{}")
        try await eventually("third request sent") { responder.requests("request").count == 3 }
        #expect(responder.requests("request").map { $0.paramsObject["n"] as? Int } == [0, 1, 2])
        _ = try await calls[0].value
        calls.forEach { $0.cancel() }
        await link.stop()
    }

    @Test func theDefaultSlotsAreTheHosts() {
        #expect(LinkLimits().maxConcurrentRequests == 8)
    }

    @Test func queuedBytesAreBoundedWhileTheSocketStalls() async throws {
        var limits = LinkLimits()
        limits.maxQueuedBytes = 4_000
        let harness = LinkHarness(limits: limits, responder: Self.silentFor(["slow"]))
        try await harness.connect()
        let link = harness.link
        let socket = try #require(harness.connector.clients.last)
        socket.holdSends()
        let stalled = Task { try await link.request("slow", timeout: .seconds(40)) }
        try await eventually("writer stalled") { socket.stalledSends == 1 }

        let padding = String(repeating: "x", count: 1_500)
        var queued: [Task<Data, Error>] = []
        for index in 0..<4 {
            queued.append(try await Self.enqueue(link, "echo", "{\"n\":\(index),\"pad\":\"\(padding)\"}", timeout: .seconds(40)))
        }
        try await eventually("two queued, two waiting") { await link.outboxLoad.waiting == 2 }
        let load = await link.outboxLoad
        #expect(load.queuedBytes <= 4_000 && load.queuedBytes > 3_000)
        // A call waiting for room that runs out of time is never sent.
        let late = Task { try await link.request("late", timeout: .seconds(2)) }
        try await harness.clock.waitForSleep(.seconds(2))
        harness.clock.advance(by: .seconds(2))
        await #expect(throws: LinkError.timeout) { try await late.value }

        socket.releaseSends()
        for call in queued {
            await #expect(throws: LinkError.self) { try await call.value }  // method_not_found, answered
        }
        let responder = harness.responder
        #expect(responder.requests("echo").map { $0.paramsObject["n"] as? Int } == [0, 1, 2, 3])
        #expect(responder.requests("late").isEmpty)
        #expect(responder.violations.isEmpty)
        #expect(await link.outboxLoad == OutboxLoad(queuedBytes: 0, requests: 0, waiting: 0))
        stalled.cancel()
        await link.stop()
    }

    @Test func aSlowReaderOverflowStartsTheSubscriptionOverFromASnapshot() async throws {
        var limits = LinkLimits()
        limits.subscriptionEvents = 4
        let snapshots = LockedCounter()
        let harness = LinkHarness(limits: limits) { _ in
            FakeResponder(snapshot: { _ in ["{\"snapshot\":\(snapshots.next())}"] })
        }
        try await harness.connect()
        let events = await harness.link.subscribe(stream: "/streams/tasks")
        let responder = harness.responder
        try await eventually("subscribed") { responder.subscriptions.count == 1 }
        let first = responder.subscriptions[0].subscriptionId
        // Nobody reads: ready, the snapshot and two patches fill the buffer; the next overflows it.
        for index in 0..<3 { try await responder.push("{\"patch\":\(index)}", to: first) }
        try await eventually("subscribed again") { responder.requests("subscribe").count == 2 }
        try await eventually("old subscription released") {
            responder.requests("subscribe.unsubscribe").first?.paramsObject["subscriptionId"] as? String == first
        }
        var iterator = events.makeAsyncIterator()
        // The reader skips what was dropped and restarts from the new snapshot.
        #expect(try await iterator.next() == .started)
        #expect(try await iterator.next() == .message(Data("{\"snapshot\":2}".utf8)))
        #expect(responder.subscriptions.count == 1)
        #expect(responder.violations.isEmpty)
        await harness.link.stop()
    }

    @Test func aSubscriptionBufferIsBoundedInBytesToo() async throws {
        var limits = LinkLimits()
        limits.subscriptionBytes = 64
        let harness = LinkHarness(limits: limits)
        try await harness.connect()
        let events = await harness.link.subscribe(stream: "/streams/tasks")
        let responder = harness.responder
        try await eventually("subscribed") { responder.subscriptions.count == 1 }
        let padding = String(repeating: "y", count: 40)
        try await responder.push("\"\(padding)\"", to: responder.subscriptions[0].subscriptionId)
        try await responder.push("\"\(padding)\"", to: responder.subscriptions[0].subscriptionId)
        try await eventually("subscribed again") { responder.requests("subscribe").count == 2 }
        var iterator = events.makeAsyncIterator()
        #expect(try await iterator.next() == .started)
        await harness.link.stop()
    }

    /// A snapshot larger than the byte bound behind an unread `.started` is still
    /// delivered: starting over would get the same snapshot and loop forever.
    @Test func aSnapshotLargerThanTheBufferFollowsAnUnreadStart() async throws {
        var limits = LinkLimits()
        limits.subscriptionBytes = 64
        let harness = LinkHarness(limits: limits)
        try await harness.connect()
        let events = await harness.link.subscribe(stream: "/streams/tasks")
        let responder = harness.responder
        try await eventually("subscribed") { responder.subscriptions.count == 1 }
        let snapshot = "\"\(String(repeating: "z", count: 200))\""
        try await responder.push(snapshot, to: responder.subscriptions[0].subscriptionId)
        try await Task.sleep(for: .milliseconds(200))
        #expect(responder.requests("subscribe").count == 1, "no start over")
        var iterator = events.makeAsyncIterator()
        #expect(try await iterator.next() == .started)
        #expect(try await iterator.next() == .message(Data(snapshot.utf8)))
        #expect(responder.requests("subscribe").count == 1)
        await harness.link.stop()
    }
}
