import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// The production socket (Network.framework) against a real WebSocket server on
/// 127.0.0.1, with the system clock: handshake, RPC, binary frames, the host's
/// close codes and refused connections.
@Suite(.timeLimit(.minutes(1)))
struct NetworkSocketTests {
    private func link(_ url: URL, timing: LinkTiming = LinkTiming()) -> ChroLink {
        ChroLink(host: .init(endpoint: url, publicKey: LinkHarness.hostPublic), deviceToken: FakeResponder.ticket, timing: timing)
    }

    @Test func theSocketAcceptsTheLargestReply() {
        // A 4 MiB JSON reply sealed and base64-encoded is about 5.6 MiB (§4.1).
        #expect(NetworkLinkSocketConnector.maximumMessageSize >= 8 * 1024 * 1024)
    }

    @Test func linksUseTheNetworkFrameworkSocket() {
        // URLSession applies App Transport Security, which refuses plain ws:// to a
        // tailnet address (100.64.0.0/10) and cannot list IP ranges as exceptions.
        // The link is end-to-end encrypted, so the socket must not depend on ATS.
        let link = ChroLink(host: .init(endpoint: URL(string: "ws://100.85.0.1:6768")!, publicKey: LinkHarness.hostPublic), deviceToken: FakeResponder.ticket)
        #expect(link.connector is NetworkLinkSocketConnector)
    }

    @Test func aLargeTextMessageCrossesInBothDirections() async throws {
        let server = try await LoopbackWebSocketServer.echo()
        defer { server.stop() }
        let socket = try await NetworkLinkSocketConnector().connect(to: server.url)
        let big = String(repeating: "a", count: 6 * 1024 * 1024)
        try await socket.send(.text(big))
        #expect(try await socket.receive() == .text(big))
        try await socket.send(.binary(Data([1, 2, 3])))
        #expect(try await socket.receive() == .binary(Data([1, 2, 3])))
        socket.close(code: 1000, reason: "done")
    }

    @Test func theHostsCloseCodeAndReasonReachThePhone() async throws {
        let server = try await LoopbackWebSocketServer.echo()
        defer { server.stop() }
        let socket = try await NetworkLinkSocketConnector().connect(to: server.url)
        try await socket.send(.text("ping"))
        _ = try await socket.receive()
        let accepted = try #require(server.sockets.first)
        accepted.close(code: 4001, reason: "Unauthorized")
        await #expect(throws: SocketClosed(code: 4001, reason: "Unauthorized", remote: true)) { try await socket.receive() }
    }

    @Test func aRefusedPortFailsTheConnectAtOnce() async throws {
        let server = try await LoopbackWebSocketServer.echo()
        let url = server.url
        server.stop()
        let started = ContinuousClock.now
        await #expect(throws: (any Error).self) { _ = try await NetworkLinkSocketConnector().connect(to: url) }
        #expect(ContinuousClock.now - started < .seconds(5))
    }

    @Test func handshakeRequestAndBinaryOverRealTCP() async throws {
        let responders = ResponderLog()
        let server = try await LoopbackWebSocketServer { responders.make() }
        defer { server.stop() }
        let link = link(server.url)
        await link.start()
        try await eventually("connected") { await link.state == .connected }
        let answer = try await link.request("status.get")
        let status = try JSONSerialization.jsonObject(with: answer) as? [String: Any]
        #expect(status?["machineName"] as? String == "studio")
        let photo = Data(repeating: 7, count: 1_000_000)
        let uploaded = try await link.upload(path: "/rpc/images/upload", fileName: "a.png", contentType: "image/png", data: photo)
        #expect(uploaded == .json(status: 200, body: Data("{\"bytes\":1000000}".utf8)))
        let downloaded = try await link.send(RawRequest(path: "/rpc/images/a/file"))
        #expect(downloaded == .binary(status: 200, contentType: "image/png", data: Data(repeating: 9, count: 2_000_000)))
        #expect(responders.all.first?.violations == [])
        await link.stop()
        let socket = try #require(server.sockets.first)
        try await eventually("phone closed") { socket.closed != nil }
        #expect(socket.closed?.remote == true)
        #expect(socket.closed?.code == 1000, "\(String(describing: socket.closed))")
    }

    @Test func aHostnameEndpointOnACustomPortCompletesTheHandshake() async throws {
        // A custom address names the desktop (`mac.tail1234.ts.net:7443`), not an
        // IP: the socket resolves the name itself and keeps the port. No ATS
        // exception is involved because Network.framework is outside ATS.
        let server = try await LoopbackWebSocketServer { FakeResponder() }
        defer { server.stop() }
        let port = try #require(server.url.port)
        #expect(port != PairingOffer.defaultPort)
        let link = link(URL(string: "ws://localhost:\(port)")!)
        await link.start()
        try await eventually("connected") { await link.state == .connected }
        let answer = try await link.request("status.get")
        let status = try JSONSerialization.jsonObject(with: answer) as? [String: Any]
        #expect(status?["machineName"] as? String == "studio")
        await link.stop()
    }

    @Test func hostCloseCodeBeforeAuthIsARejection() async throws {
        let server = try await LoopbackWebSocketServer { FakeResponder(behavior: .rejectAuth(code: "unauthorized")) }
        defer { server.stop() }
        var timing = LinkTiming()
        timing.maxRejections = 1
        let link = link(server.url, timing: timing)
        await link.start()
        try await eventually("auth failed") { await link.state == .authFailed }
    }

    @Test func hostClosing4001AfterHelloIsARejection() async throws {
        let server = try await LoopbackWebSocketServer { FakeResponder(behavior: .closeAfterHello(code: 4001, reason: "Invalid handshake message")) }
        defer { server.stop() }
        var timing = LinkTiming()
        timing.maxRejections = 1
        let link = link(server.url, timing: timing)
        await link.start()
        try await eventually("auth failed") { await link.state == .authFailed }
    }

    @Test func refusedConnectionWaitsToRetry() async throws {
        let server = try await LoopbackWebSocketServer { FakeResponder() }
        let url = server.url
        server.stop()
        let link = link(url)
        await link.start()
        try await eventually("waiting") {
            if case .waiting(failures: 1, _) = await link.state { return true }
            return false
        }
        await link.stop()
    }
}

/// Keeps the responders a server created.
final class ResponderLog: @unchecked Sendable {
    private let lock = NSLock()
    private var made: [FakeResponder] = []

    func make() -> FakeResponder {
        let responder = FakeResponder(routes: { http in
            if let upload = http.upload { return .json(status: 200, "{\"bytes\":\(upload.data.count)}") }
            return .binary(status: 200, contentType: "image/png", Data(repeating: 9, count: 2_000_000))
        })
        lock.withLock { made.append(responder) }
        return responder
    }

    var all: [FakeResponder] { lock.withLock { made } }
}
