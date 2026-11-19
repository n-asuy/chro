import Foundation
import Network

/// One WebSocket message; the opcode decides the E2EE frame kind.
public enum LinkMessage: Sendable, Equatable {
    case text(String)
    case binary(Data)
}

/// The socket ended. `remote` is true when the peer sent the close frame.
public struct SocketClosed: LocalizedError, Equatable, Sendable {
    public let code: Int
    public let reason: String
    public let remote: Bool

    public init(code: Int, reason: String, remote: Bool) {
        self.code = code
        self.reason = reason
        self.remote = remote
    }

    public var errorDescription: String? { reason.isEmpty ? "Connection closed (\(code))" : reason }
}

/// An open WebSocket. No headers, query or subprotocol are ever sent: all
/// authentication happens inside E2EE v2.
public protocol LinkSocket: AnyObject, Sendable {
    func send(_ message: LinkMessage) async throws
    /// Next message; throws `SocketClosed` once the socket has ended.
    func receive() async throws -> LinkMessage
    /// Closes the socket (idempotent) and makes pending and later `receive` calls throw.
    func close(code: Int, reason: String)
}

/// Opens sockets; returns once the WebSocket upgrade has completed.
public protocol LinkSocketConnector: Sendable {
    func connect(to url: URL) async throws -> any LinkSocket
}

/// Close codes the phone uses (the host's are listed in spec §3.2).
enum CloseCode {
    static let normal = 1000
    static let invalidHandshake = 4001
    static let handshakeTimeout = 4002
    static let tooManyDecryptionFailures = 4003
}

/// Opens Network.framework WebSockets.
///
/// Not URLSession: App Transport Security governs URLSession and refuses plain
/// `ws://` to a tailnet address (100.64.0.0/10), and ATS exceptions cannot name IP
/// ranges. The link needs no TLS: everything after the hello is E2EE v2 sealed and
/// the host key is pinned from the QR.
public struct NetworkLinkSocketConnector: LinkSocketConnector {
    /// Above the host's largest reply (8 MiB binary, 4 MiB JSON as base64) plus framing.
    public static let maximumMessageSize = 16 * 1024 * 1024

    public init() {}

    public func connect(to url: URL) async throws -> any LinkSocket {
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        options.maximumMessageSize = Self.maximumMessageSize
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        let socket = NetworkLinkSocket(NWConnection(to: .url(url), using: parameters))
        try await socket.open()
        return socket
    }
}

/// One WebSocket over an `NWConnection`, client or server side (the tests' host
/// accepts connections with the same type).
final class NetworkLinkSocket: LinkSocket, @unchecked Sendable {
    private let connection: NWConnection
    private let queue = DispatchQueue(label: "chro.link.socket")
    private let lock = NSLock()
    private var ended: SocketClosed?
    private var pendingOpen: CheckedContinuation<Void, Error>?

    init(_ connection: NWConnection) {
        self.connection = connection
    }

    /// Starts the connection and returns once the WebSocket upgrade has completed.
    func open() async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                if let ended {
                    lock.unlock()
                    continuation.resume(throwing: ended)
                    return
                }
                pendingOpen = continuation
                lock.unlock()
                connection.stateUpdateHandler = { [weak self] state in self?.update(state) }
                connection.start(queue: queue)
            }
        } onCancel: {
            self.close(code: CloseCode.normal, reason: "Cancelled")
        }
    }

    /// Starts an accepted (server side) connection; messages flow once it is ready.
    func start() {
        connection.stateUpdateHandler = { [weak self] state in self?.update(state) }
        connection.start(queue: queue)
    }

    var closed: SocketClosed? { lock.withLock { ended } }

    func send(_ message: LinkMessage) async throws {
        if let ended = closed { throw ended }
        let (opcode, data): (NWProtocolWebSocket.Opcode, Data) = switch message {
        case .text(let text): (.text, Data(text.utf8))
        case .binary(let data): (.binary, data)
        }
        let context = NWConnection.ContentContext(identifier: "message", metadata: [NWProtocolWebSocket.Metadata(opcode: opcode)])
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] error in
                if let error {
                    continuation.resume(throwing: self?.closed ?? SocketClosed(code: 1006, reason: error.localizedDescription, remote: true))
                } else {
                    continuation.resume()
                }
            })
        }
    }

    func receive() async throws -> LinkMessage {
        while true {
            if let ended = closed { throw ended }
            let (data, metadata) = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(Data?, NWProtocolWebSocket.Metadata?), Error>) in
                connection.receiveMessage { [weak self] data, context, _, error in
                    if let error {
                        let lost = SocketClosed(code: 1006, reason: error.localizedDescription, remote: true)
                        continuation.resume(throwing: self?.end(lost) ?? lost)
                        return
                    }
                    let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
                    continuation.resume(returning: (data, metadata))
                }
            }
            guard let metadata else {
                throw end(SocketClosed(code: 1006, reason: "Connection lost", remote: true))
            }
            switch metadata.opcode {
            case .text: return .text(String(decoding: data ?? Data(), as: UTF8.self))
            case .binary: return .binary(data ?? Data())
            case .close:
                let closed = end(SocketClosed(code: Self.code(metadata.closeCode), reason: String(decoding: data ?? Data(), as: UTF8.self), remote: true))
                connection.cancel()
                throw closed
            default: continue
            }
        }
    }

    func close(code: Int, reason: String) {
        let closed = SocketClosed(code: code, reason: reason, remote: false)
        let (first, waiting) = lock.withLock { () -> (Bool, CheckedContinuation<Void, Error>?) in
            guard ended == nil else { return (false, nil) }
            ended = closed
            defer { pendingOpen = nil }
            return (true, pendingOpen)
        }
        guard first else { return }
        if let waiting {
            waiting.resume(throwing: closed)
            connection.cancel()
            return
        }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
        metadata.closeCode = switch code {
        case 4000..<5000: .privateCode(UInt16(code))
        case 3000..<4000: .applicationCode(UInt16(code))
        default: .protocolCode(NWProtocolWebSocket.CloseCode.Defined(rawValue: UInt16(code)) ?? .normalClosure)
        }
        let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
        // Cancelling right after the close frame can reset the TCP connection before the peer
        // reads the frame (it then sees 1006 instead of the code). The peer's reply ends the
        // connection through `receive`; the grace period covers a peer that never answers.
        connection.send(content: Data(reason.utf8), contentContext: context, isComplete: true, completion: .contentProcessed { [connection, queue] _ in
            queue.asyncAfter(deadline: .now() + Self.closeGrace) { connection.cancel() }
        })
    }

    // MARK: State

    private func update(_ state: NWConnection.State) {
        switch state {
        case .ready:
            let waiting = lock.withLock { () -> CheckedContinuation<Void, Error>? in
                defer { pendingOpen = nil }
                return pendingOpen
            }
            waiting?.resume()
        case .waiting(let error), .failed(let error):
            // While opening, `.waiting` is a refused or unreachable endpoint: fail the attempt
            // now and let the link's own backoff decide when to try again. Once open, the
            // connection can fail right after the peer's close frame and before `receive`
            // delivers it; the receive path reports the end (with the peer's code) instead.
            let failed = SocketClosed(code: 1006, reason: error.localizedDescription, remote: true)
            let waiting = lock.withLock { () -> CheckedContinuation<Void, Error>? in
                guard let pending = pendingOpen else { return nil }
                pendingOpen = nil
                if ended == nil { ended = failed }
                return pending
            }
            guard let waiting else { return }
            waiting.resume(throwing: failed)
            connection.cancel()
        case .cancelled:
            end(SocketClosed(code: 1006, reason: "Connection lost", remote: true))
        default:
            break
        }
    }

    /// Records the first end of the socket and returns the recorded one.
    @discardableResult
    private func end(_ closed: SocketClosed) -> SocketClosed {
        let waiting: CheckedContinuation<Void, Error>?
        let recorded: SocketClosed
        lock.lock()
        if ended == nil { ended = closed }
        recorded = ended ?? closed
        waiting = pendingOpen
        pendingOpen = nil
        lock.unlock()
        waiting?.resume(throwing: recorded)
        return recorded
    }

    /// How long a closing socket waits for the peer's close frame before cancelling.
    static let closeGrace: TimeInterval = 1

    private static func code(_ closeCode: NWProtocolWebSocket.CloseCode) -> Int {
        switch closeCode {
        case .protocolCode(let code): Int(code.rawValue)
        case .applicationCode(let code): Int(code)
        case .privateCode(let code): Int(code)
        @unknown default: 1006
        }
    }
}
