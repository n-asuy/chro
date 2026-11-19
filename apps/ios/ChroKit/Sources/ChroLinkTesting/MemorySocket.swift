import Foundation
@testable import ChroLink

/// A socket end whose closing can be observed by the test.
protocol ClosingObservable {
    var closed: SocketClosed? { get }
}

/// One end of an in-process WebSocket pair.
final class MemorySocket: LinkSocket, ClosingObservable, @unchecked Sendable {
    private let lock = NSLock()
    private weak var peer: MemorySocket?
    private var inbox: [LinkMessage] = []
    private var waiter: CheckedContinuation<LinkMessage, Error>?
    private var ended: SocketClosed?
    private var sentLog: [LinkMessage] = []
    /// While held, `send` waits (a stalled network); held messages are delivered in order on release.
    private var holding = false
    private var held: [(message: LinkMessage, sender: CheckedContinuation<Void, Error>)] = []

    static func pair() -> (client: MemorySocket, server: MemorySocket) {
        let client = MemorySocket()
        let server = MemorySocket()
        client.peer = server
        server.peer = client
        return (client, server)
    }

    /// Everything this end has sent, in order.
    var sent: [LinkMessage] { lock.withLock { sentLog } }

    /// How this end ended, if it has.
    var closed: SocketClosed? { lock.withLock { ended } }

    /// Stalls every later `send` until `releaseSends()`.
    func holdSends() { lock.withLock { holding = true } }

    func releaseSends() {
        let (released, peer) = lock.withLock { () -> ([(message: LinkMessage, sender: CheckedContinuation<Void, Error>)], MemorySocket?) in
            holding = false
            defer { held.removeAll() }
            sentLog.append(contentsOf: held.map(\.message))
            return (held, self.peer)
        }
        for item in released { peer?.deliver(item.message) }
        for item in released { item.sender.resume() }
    }

    /// Sends waiting on the hold.
    var stalledSends: Int { lock.withLock { held.count } }

    /// Delivers at once (no suspension, so concurrent senders keep their order) unless held.
    func send(_ message: LinkMessage) async throws {
        if try deliverUnlessHeld(message) { return }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            do {
                if try deliverUnlessHeld(message, orHoldFor: continuation) { continuation.resume() }
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    /// Delivers at once, without suspending; false while sends are held (the caller
    /// then falls back to `send`).
    func sendNow(_ message: LinkMessage) throws -> Bool {
        try deliverUnlessHeld(message)
    }

    /// Sends now and returns true, or (while held) parks `sender` with the message and returns false.
    private func deliverUnlessHeld(_ message: LinkMessage, orHoldFor sender: CheckedContinuation<Void, Error>? = nil) throws -> Bool {
        let peer = try lock.withLock { () -> MemorySocket?? in
            if let ended { throw ended }
            if holding {
                if let sender { held.append((message, sender)) }
                return .none
            }
            sentLog.append(message)
            return .some(self.peer)
        }
        guard let peer else { return false }
        peer?.deliver(message)
        return true
    }

    func receive() async throws -> LinkMessage {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<LinkMessage, Error>) in
                lock.lock()
                if !inbox.isEmpty {
                    let message = inbox.removeFirst()
                    lock.unlock()
                    continuation.resume(returning: message)
                } else if let ended {
                    lock.unlock()
                    continuation.resume(throwing: ended)
                } else if Task.isCancelled {
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                } else {
                    precondition(waiter == nil, "one receiver at a time")
                    waiter = continuation
                    lock.unlock()
                }
            }
        } onCancel: {
            let waiter = lock.withLock { () -> CheckedContinuation<LinkMessage, Error>? in
                defer { self.waiter = nil }
                return self.waiter
            }
            waiter?.resume(throwing: CancellationError())
        }
    }

    func close(code: Int, reason: String) {
        let (waiter, peer, first) = lock.withLock { () -> (CheckedContinuation<LinkMessage, Error>?, MemorySocket?, Bool) in
            guard ended == nil else { return (nil, nil, false) }
            ended = SocketClosed(code: code, reason: reason, remote: false)
            inbox.removeAll()
            defer { self.waiter = nil }
            return (self.waiter, self.peer, true)
        }
        guard first else { return }
        let stalled = lock.withLock { () -> [CheckedContinuation<Void, Error>] in
            defer { held.removeAll() }
            return held.map(\.sender)
        }
        for sender in stalled { sender.resume(throwing: SocketClosed(code: code, reason: reason, remote: false)) }
        waiter?.resume(throwing: SocketClosed(code: code, reason: reason, remote: false))
        peer?.closedByPeer(code: code, reason: reason)
    }

    private func deliver(_ message: LinkMessage) {
        let waiter = lock.withLock { () -> CheckedContinuation<LinkMessage, Error>? in
            guard ended == nil else { return nil }
            if let waiter = self.waiter {
                self.waiter = nil
                return waiter
            }
            inbox.append(message)
            return nil
        }
        waiter?.resume(returning: message)
    }

    private func closedByPeer(code: Int, reason: String) {
        let waiter = lock.withLock { () -> CheckedContinuation<LinkMessage, Error>? in
            guard ended == nil else { return nil }
            ended = SocketClosed(code: code, reason: reason, remote: true)
            defer { self.waiter = nil }
            return self.waiter
        }
        waiter?.resume(throwing: SocketClosed(code: code, reason: reason, remote: true))
    }
}

/// Hands out in-process sockets; each attempt follows the next scripted behaviour.
final class FakeConnector: LinkSocketConnector, @unchecked Sendable {
    enum Behavior {
        /// Connection refused at once.
        case refuse
        /// Never completes until the attempt is cancelled.
        case hang
        /// Connects and serves the phone with this responder.
        case accept(FakeResponder)
    }

    private let lock = NSLock()
    private let script: @Sendable (Int) -> Behavior
    private var count = 0
    private var urls: [URL] = []
    private var served: [FakeResponder] = []
    private var clientSockets: [MemorySocket] = []
    private var hanging: [UUID: CheckedContinuation<Void, Error>] = [:]

    init(_ script: @escaping @Sendable (Int) -> Behavior) {
        self.script = script
    }

    /// Every attempt gets a fresh honest responder built by `make`.
    convenience init(responder make: @escaping @Sendable (Int) -> FakeResponder) {
        self.init { .accept(make($0)) }
    }

    var attempts: Int { lock.withLock { count } }
    var connectedURLs: [URL] { lock.withLock { urls } }
    var responders: [FakeResponder] { lock.withLock { served } }
    /// The phone's ends of the accepted connections, in order.
    var clients: [MemorySocket] { lock.withLock { clientSockets } }

    func connect(to url: URL) async throws -> any LinkSocket {
        let attempt = lock.withLock { () -> Int in
            count += 1
            urls.append(url)
            return count
        }
        switch script(attempt) {
        case .refuse:
            throw URLError(.cannotConnectToHost)
        case .hang:
            let id = UUID()
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    // Resumed by cancellation only.
                    lock.lock()
                    if Task.isCancelled {
                        lock.unlock()
                        continuation.resume(throwing: CancellationError())
                    } else {
                        hanging[id] = continuation
                        lock.unlock()
                    }
                }
            } onCancel: {
                lock.withLock { hanging.removeValue(forKey: id) }?.resume(throwing: CancellationError())
            }
            throw CancellationError()
        case .accept(let responder):
            let (client, server) = MemorySocket.pair()
            lock.withLock {
                served.append(responder)
                clientSockets.append(client)
            }
            responder.serve(server)
            return client
        }
    }
}
