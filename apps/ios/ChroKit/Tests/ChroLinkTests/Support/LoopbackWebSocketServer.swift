import Foundation
import Network
@testable import ChroLink
@testable import ChroLinkTesting

/// A real WebSocket server on 127.0.0.1 that hands each accepted connection to a
/// fresh responder (or another handler), so the phone's socket is tested over TCP
/// end to end. Accepted connections use the production `NetworkLinkSocket`.
final class LoopbackWebSocketServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "loopback-ws")
    private let lock = NSLock()
    private let serve: @Sendable (any LinkSocket) -> Void
    private var connections: [NetworkLinkSocket] = []

    convenience init(responder make: @escaping @Sendable () -> FakeResponder) async throws {
        try await self.init(serve: { socket in make().serve(socket) })
    }

    init(serve: @escaping @Sendable (any LinkSocket) -> Void) async throws {
        let parameters = NWParameters.tcp
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        options.maximumMessageSize = NetworkLinkSocketConnector.maximumMessageSize
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        self.serve = serve
        let (ready, readyContinuation) = AsyncStream<Bool>.makeStream()
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: readyContinuation.yield(true)
            case .failed, .cancelled: readyContinuation.yield(false)
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
        var iterator = ready.makeAsyncIterator()
        guard await iterator.next() == true, port != 0 else { throw URLError(.cannotFindHost) }
    }

    private func accept(_ connection: NWConnection) {
        let socket = NetworkLinkSocket(connection)
        lock.withLock { connections.append(socket) }
        socket.start()
        serve(socket)
    }

    var port: UInt16 { listener.port?.rawValue ?? 0 }
    var url: URL { URL(string: "ws://127.0.0.1:\(port)")! }
    var sockets: [NetworkLinkSocket] { lock.withLock { connections } }

    func stop() {
        listener.cancel()
        for socket in sockets { socket.close(code: 1001, reason: "Server stopped") }
    }
}

extension NetworkLinkSocket: ClosingObservable {}

/// Echoes every message back until the phone closes.
private func echo(_ socket: any LinkSocket) {
    Task {
        while let message = try? await socket.receive() {
            try? await socket.send(message)
        }
    }
}

extension LoopbackWebSocketServer {
    static func echo() async throws -> LoopbackWebSocketServer {
        try await LoopbackWebSocketServer(serve: { socket in ChroLinkTests.echo(socket) })
    }
}
