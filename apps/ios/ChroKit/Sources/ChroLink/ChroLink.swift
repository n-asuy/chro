import Foundation

/// One event of a subscription.
public enum StreamEvent: Sendable, Equatable {
    /// The subscription is live on a (new) connection; a fresh snapshot follows,
    /// so state built from earlier messages should be replaced, not patched.
    case started
    /// One message of the stream, as the desktop's `/streams/*` WebSocket sends it (JSON text).
    case message(Data)
}

/// The phone's connection to one paired desktop: E2EE v2 over a WebSocket,
/// RPC with ids and timeouts, subscriptions that survive reconnects, the
/// reconnect schedule and the liveness watchdog of spec §4.3.
///
/// The connection loop keeps the link alive until `stop()`; call it when the
/// link is no longer needed.
public actor ChroLink {
    public struct Host: Sendable, Equatable {
        public var endpoint: URL
        /// The host's X25519 key from the QR; `e2ee_ready` must carry exactly this key.
        public var publicKey: Data
        public var context: HandshakeContext

        public init(endpoint: URL, publicKey: Data, context: HandshakeContext = .direct) {
            self.endpoint = endpoint
            self.publicKey = publicKey
            self.context = context
        }
    }

    public enum State: Sendable, Equatable {
        case idle
        case connecting(attempt: Int)
        case connected
        /// Waiting `delay` before the next attempt, after `failures` failed ones in a row.
        case waiting(failures: Int, delay: Duration)
        /// Rejected `maxRejections` times in a row; reconnecting stopped.
        case authFailed
        /// The desktop speaks another `apiGeneration`; reconnecting stopped.
        case incompatible
        case stopped

        public var isTerminal: Bool {
            switch self {
            case .authFailed, .incompatible, .stopped: true
            default: false
            }
        }
    }

    /// Compatibility generation of the device API (architecture doc §4).
    public static let apiGeneration = 1
    /// The host sends a stream message too large for one reply as ordered parts.
    public static let messagePartsCapability = "stream.message-parts.v1"
    /// Capabilities this app advertises in `runtime.clientCapabilities.update`.
    public static let clientCapabilities: [String] = [messagePartsCapability]

    public let host: Host
    public let deviceToken: String
    public let timing: LinkTiming
    public let limits: LinkLimits
    nonisolated let connector: any LinkSocketConnector
    private let clock: any LinkClock
    private let random: any LinkRandom

    public private(set) var state: State = .idle
    /// What the host of the current connection advertised in the capabilities update.
    private var hostCapabilities: Set<String> = []
    /// Why the last attempt could not open the socket (refused, unreachable, no answer
    /// within the connect deadline). Cleared when a socket opens.
    public private(set) var lastConnectFailure: String?
    private var stateObservers: [UUID: AsyncStream<State>.Continuation] = [:]
    private var loop: Task<Void, Never>?
    private var retrySleeper: Task<Void, Error>?
    private var handshakingSocket: (any LinkSocket)?
    private var channel: LinkChannel?
    private var watchdog: LivenessWatchdog?
    private var watchdogTask: Task<Void, Never>?
    private var channelWaiters: [UUID: CheckedContinuation<LinkChannel, Error>] = [:]
    private var waiterTimers: [UUID: Task<Void, Never>] = [:]
    private var subscriptions: [UUID: Subscription] = [:]

    private struct Subscription {
        let stream: String
        /// Read at every (re)subscription, so a reconnect asks for the reader's current view.
        let params: @Sendable () -> Data
        let buffer: SubscriptionBuffer
        var pump: Task<Void, Never>?
        var subscriptionId: String?
    }

    public init(
        host: Host,
        deviceToken: String,
        connector: any LinkSocketConnector = NetworkLinkSocketConnector(),
        clock: any LinkClock = SystemLinkClock(),
        random: any LinkRandom = SystemLinkRandom(),
        timing: LinkTiming = LinkTiming(),
        limits: LinkLimits = LinkLimits()
    ) {
        self.host = host
        self.deviceToken = deviceToken
        self.connector = connector
        self.clock = clock
        self.random = random
        self.timing = timing
        self.limits = limits
    }

    // MARK: Lifecycle

    /// Starts connecting; reconnects on its own until `stop()` or a terminal state.
    public func start() {
        guard loop == nil, !state.isTerminal else { return }
        loop = Task { await self.run() }
    }

    /// Closes the connection and stops reconnecting. Pending calls fail with `.stopped`.
    public func stop() {
        guard state != .stopped else { return }
        loop?.cancel()
        retrySleeper?.cancel()
        handshakingSocket?.close(code: CloseCode.normal, reason: "Client stopped")
        enterTerminal(.stopped, error: LinkError.stopped)
    }

    /// The app came back from the background or the network changed: probe the
    /// live connection with a short deadline, or retry at once if waiting.
    public func connectionMayHaveChanged() async {
        if case .waiting = state {
            retrySleeper?.cancel()
            return
        }
        await watchdog?.checkNow()
    }

    /// The current state first, then every change.
    public func states() -> AsyncStream<State> {
        // Readers follow the transitions (the pairing log reports each wait), which come
        // at most once per reconnect step; the bound only matters for a reader that stalls.
        let (stream, continuation) = AsyncStream<State>.makeStream(bufferingPolicy: .bufferingNewest(32))
        let id = UUID()
        continuation.yield(state)
        stateObservers[id] = continuation
        continuation.onTermination = { _ in Task { await self.removeObserver(id) } }
        return stream
    }

    private func removeObserver(_ id: UUID) {
        stateObservers.removeValue(forKey: id)
    }

    private func setState(_ newState: State) {
        guard state != newState else { return }
        state = newState
        for observer in stateObservers.values { observer.yield(newState) }
        if newState.isTerminal {
            for observer in stateObservers.values { observer.finish() }
            stateObservers.removeAll()
        }
    }

    // MARK: Connection loop

    private enum Attempt {
        case authenticated(LinkChannel)
        case rejected
        case failed
    }

    private func run() async {
        var failures = 0
        var rejections = 0
        var attempt = 0
        while !Task.isCancelled, !state.isTerminal {
            attempt += 1
            setState(.connecting(attempt: attempt))
            switch await connectOnce() {
            case .authenticated(let channel):
                failures = 0
                switch await negotiate(channel) {
                case .incompatible:
                    await channel.close()
                    enterTerminal(.incompatible, error: LinkError.incompatibleAPI)
                    return
                case .failed:
                    // The host refuses `request` and `subscribe` until the update succeeds: retry the connection.
                    await channel.close()
                    rejections = 0
                case .accepted(let capabilities):
                    guard !Task.isCancelled, !state.isTerminal else {
                        await channel.close()
                        return
                    }
                    hostCapabilities = capabilities
                    // A channel the host already closed during negotiation is never published.
                    if await channel.end == nil { publish(channel) }
                    let end = await channel.ended()
                    unpublish(channel)
                    rejections = end.isRejection ? rejections + 1 : 0
                }
            case .rejected:
                rejections += 1
            case .failed:
                break
            }
            guard !Task.isCancelled, !state.isTerminal else { return }
            if rejections >= timing.maxRejections {
                enterTerminal(.authFailed, error: LinkError.authFailed)
                return
            }
            failures += 1
            let delay = timing.reconnect.delay(afterFailures: failures)
            setState(.waiting(failures: failures, delay: delay))
            let sleeper = Task { [clock] in try await clock.sleep(for: delay) }
            retrySleeper = sleeper
            _ = await sleeper.result
            retrySleeper = nil
        }
    }

    /// One attempt: open the socket within 12 s, then authenticate within 10 s.
    private func connectOnce() async -> Attempt {
        let connector = self.connector
        let endpoint = host.endpoint
        let socket: any LinkSocket
        do {
            socket = try await withDeadline(timing.connectDeadline, clock: clock) {
                try await connector.connect(to: endpoint)
            }
        } catch is DeadlineExceeded {
            lastConnectFailure = "No answer within \(timing.connectDeadline.components.seconds)s"
            return .failed
        } catch {
            lastConnectFailure = error.localizedDescription
            return .failed
        }
        lastConnectFailure = nil
        guard !Task.isCancelled, !state.isTerminal else {
            socket.close(code: CloseCode.normal, reason: "Client stopped")
            return .failed
        }
        handshakingSocket = socket
        defer { handshakingSocket = nil }
        let initiator: HandshakeInitiator
        do {
            initiator = try HandshakeInitiator(
                context: host.context,
                pinnedHostKey: host.publicKey,
                deviceToken: deviceToken,
                clientSecretKey: random.bytes(32),
                clientNonce: random.bytes(32)
            )
        } catch {
            socket.close(code: CloseCode.normal, reason: "Client error")
            return .failed
        }
        do {
            let done = try await withDeadline(timing.handshakeDeadline, clock: clock, onTimeout: {
                socket.close(code: CloseCode.handshakeTimeout, reason: "E2EE handshake timeout")
            }) {
                try await Self.handshake(socket: socket, initiator: initiator)
            }
            guard let sealer = done.sealer, let opener = done.opener else { return .failed }
            return .authenticated(LinkChannel(socket: socket, sealer: sealer, opener: opener, deviceToken: deviceToken, clock: clock, limits: limits))
        } catch let error as HandshakeError {
            if case .closedByHost = error {} else {
                socket.close(code: CloseCode.invalidHandshake, reason: "Invalid handshake message")
            }
            return .rejected
        } catch {
            socket.close(code: CloseCode.normal, reason: "Handshake failed")
            return .failed
        }
    }

    static func handshake(socket: any LinkSocket, initiator: HandshakeInitiator) async throws -> HandshakeInitiator {
        var handshake = initiator
        try await socket.send(.text(handshake.hello))
        let auth = try handshake.receiveReady(try await receiveHandshakeText(socket))
        try await socket.send(.text(auth))
        try handshake.receiveAuthenticated(try await receiveHandshakeText(socket))
        return handshake
    }

    private static func receiveHandshakeText(_ socket: any LinkSocket) async throws -> String {
        do {
            switch try await socket.receive() {
            case .text(let text): return text
            case .binary: throw HandshakeError.unexpectedBinary
            }
        } catch let closed as SocketClosed where closed.remote && (4000..<5000).contains(closed.code) {
            // An application close code from the host is its verdict on the handshake.
            throw HandshakeError.closedByHost(code: closed.code, reason: closed.reason)
        }
    }

    private enum Negotiation {
        /// With the capabilities the host advertised.
        case accepted(Set<String>)
        /// The desktop speaks another `apiGeneration`.
        case incompatible
        /// Any other error or no answer within 5 s.
        case failed
    }

    /// `runtime.clientCapabilities.update`. Calls and subscriptions wait until it
    /// succeeds: the connection is published only then (§4.1).
    private func negotiate(_ channel: LinkChannel) async -> Negotiation {
        let params = try! RPCCoding.encode(CapabilitiesUpdate(clientCapabilities: Self.clientCapabilities, apiGeneration: Self.apiGeneration))
        do {
            let result = try await channel.request(method: "runtime.clientCapabilities.update", params: params, timeout: timing.capabilitiesTimeout)
            return .accepted(Set((try? RPCCoding.decode(CapabilitiesResult.self, from: result))?.capabilities ?? []))
        } catch LinkError.rpc(let error) where error.code == RPCError.incompatibleAPICode {
            return .incompatible
        } catch {
            return .failed
        }
    }

    private func publish(_ channel: LinkChannel) {
        self.channel = channel
        setState(.connected)
        for waiter in channelWaiters.values { waiter.resume(returning: channel) }
        channelWaiters.removeAll()
        for timer in waiterTimers.values { timer.cancel() }
        waiterTimers.removeAll()
        for id in subscriptions.keys { startPump(id, on: channel) }
        let policy = timing.liveness
        let watchdog = LivenessWatchdog(
            policy: policy,
            clock: clock,
            lastReceived: { await channel.lastReceived },
            probe: { timeout in
                do {
                    _ = try await channel.request(method: "status.get", params: Data("{\"probe\":true}".utf8), timeout: timeout)
                    return true
                } catch LinkError.rpc {
                    return true  // an error answer still proves the link is alive
                } catch {
                    return false
                }
            },
            fail: { await channel.close(reason: "Liveness probe failed") }
        )
        self.watchdog = watchdog
        watchdogTask = Task { await watchdog.run() }
    }

    private func unpublish(_ channel: LinkChannel) {
        guard self.channel === channel else { return }
        self.channel = nil
        watchdogTask?.cancel()
        watchdogTask = nil
        watchdog = nil
        for id in subscriptions.keys {
            subscriptions[id]?.pump?.cancel()
            subscriptions[id]?.pump = nil
            subscriptions[id]?.subscriptionId = nil
        }
    }

    private func enterTerminal(_ terminal: State, error: LinkError) {
        loop?.cancel()
        loop = nil
        let channel = self.channel
        if let channel { unpublish(channel) }
        Task { await channel?.close() }
        for waiter in channelWaiters.values { waiter.resume(throwing: error) }
        channelWaiters.removeAll()
        for timer in waiterTimers.values { timer.cancel() }
        waiterTimers.removeAll()
        let open = subscriptions
        subscriptions.removeAll()
        for subscription in open.values {
            subscription.pump?.cancel()
            subscription.buffer.finish(throwing: error)
        }
        setState(terminal)
    }

    private var terminalError: LinkError {
        switch state {
        case .authFailed: .authFailed
        case .incompatible: .incompatibleAPI
        default: .stopped
        }
    }

    // MARK: Requests

    /// Sends `method` with `params` (JSON text) and returns the result (JSON text).
    /// Waits for a connection first; the timeout covers the wait and the call.
    public func request(_ method: String, params: Data = Data("{}".utf8), timeout: Duration? = nil) async throws -> Data {
        try await onChannel(timeout) { channel, remaining in
            try await channel.request(method: method, params: params, timeout: remaining)
        }
    }

    /// Typed form of `request`: params encode and the result decodes with camelCase keys.
    public func request<Params: Encodable & Sendable, Result: Decodable & Sendable>(
        _ method: String, params: Params, as type: Result.Type, timeout: Duration? = nil
    ) async throws -> Result {
        let data = try await request(method, params: try RPCCoding.encode(params), timeout: timeout)
        return try RPCCoding.decode(type, from: data)
    }

    /// Like `request`, but the reply may arrive in binary frames.
    func call(_ method: String, params: Data, timeout: Duration?) async throws -> ChannelReply {
        try await onChannel(timeout) { channel, remaining in
            try await channel.call(method: method, params: params, timeout: remaining)
        }
    }

    /// A `request` whose body travels in binary frames.
    func upload(params: Data, body: Data, timeout: Duration?) async throws -> ChannelReply {
        try await onChannel(timeout) { channel, remaining in
            try await channel.upload(params: params, body: body, timeout: remaining)
        }
    }

    private func onChannel<T: Sendable>(_ timeout: Duration?, _ body: @Sendable (LinkChannel, Duration) async throws -> T) async throws -> T {
        let timeout = timeout ?? timing.requestTimeout
        let deadline = clock.now() + timeout
        let channel = try await currentChannel(timeout: timeout)
        let remaining = deadline - clock.now()
        guard remaining > .zero else { throw LinkError.timeout }
        return try await body(channel, remaining)
    }

    private func currentChannel(timeout: Duration) async throws -> LinkChannel {
        if let channel { return channel }
        if state.isTerminal { throw terminalError }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<LinkChannel, Error>) in
                channelWaiters[id] = continuation
                waiterTimers[id] = Task { [clock] in
                    guard (try? await clock.sleep(for: timeout)) != nil else { return }
                    self.failWaiter(id, LinkError.timeout)
                }
            }
        } onCancel: {
            Task { await self.failWaiter(id, CancellationError()) }
        }
    }

    private func failWaiter(_ id: UUID, _ error: Error) {
        waiterTimers.removeValue(forKey: id)?.cancel()
        channelWaiters.removeValue(forKey: id)?.resume(throwing: error)
    }

    /// The capabilities the host advertised, once connected (waits like a request).
    public func capabilities(timeout: Duration? = nil) async throws -> Set<String> {
        _ = try await currentChannel(timeout: timeout ?? timing.requestTimeout)
        return hostCapabilities
    }

    // MARK: Subscriptions

    /// What the current connection's outbox holds (zero while disconnected).
    var outboxLoad: OutboxLoad {
        get async { await channel?.outboxLoad ?? OutboxLoad(queuedBytes: 0, requests: 0, waiting: 0) }
    }

    /// Items the current connection has queued so far.
    var enqueuedCount: Int {
        get async { await channel?.enqueuedCount ?? 0 }
    }

    /// Subscribes to a desktop stream (`/streams/...` path template) and keeps the
    /// subscription across reconnects and reader overflows (each starts it over
    /// with `.started` and a fresh snapshot). Ending the iteration unsubscribes.
    public func subscribe(stream: String, params: Data = Data("{}".utf8)) -> LinkSubscription {
        subscribe(stream: stream, params: { params })
    }

    /// Like `subscribe(stream:params:)`, with params read again at every
    /// (re)subscription: a reconnect's snapshot follows the reader's current view.
    public func subscribe(stream: String, params: @escaping @Sendable () -> Data) -> LinkSubscription {
        let buffer = SubscriptionBuffer(maxEvents: limits.subscriptionEvents, maxBytes: limits.subscriptionBytes)
        let events = LinkSubscription(buffer: buffer)
        if state.isTerminal {
            buffer.finish(throwing: terminalError)
            return events
        }
        let id = UUID()
        subscriptions[id] = Subscription(stream: stream, params: params, buffer: buffer)
        buffer.onReaderGone { Task { await self.unsubscribe(id) } }
        if let channel { startPump(id, on: channel) }
        return events
    }

    /// Server-side ids of the live subscriptions (for diagnostics and tests).
    var subscriptionIds: [String] { subscriptions.values.compactMap(\.subscriptionId).sorted() }

    private func startPump(_ id: UUID, on channel: LinkChannel) {
        subscriptions[id]?.pump = Task { await self.pump(id, on: channel) }
    }

    private func pump(_ id: UUID, on channel: LinkChannel) async {
        guard let subscription = subscriptions[id] else { return }
        var params = Data("{\"stream\":\(HandshakeMessages.quote(subscription.stream)),\"params\":".utf8)
        params.append(subscription.params())
        params.append(Data("}".utf8))
        let responses: AsyncThrowingStream<Data, Error>
        do {
            responses = try await channel.openStream(method: "subscribe", params: params).responses
        } catch {
            return  // the channel ended; the next connection restarts the pump
        }
        // The text of a message arriving in parts, joined until the final part.
        var assembling: Data?
        do {
            for try await result in responses {
                guard !Task.isCancelled else { return }
                let parsed = try SubscriptionResult(result)
                guard subscriptions[id] != nil else {
                    // The reader left while the subscribe was in flight: release the host's side now.
                    if case .ready(let subscriptionId) = parsed { release(subscriptionId, on: channel) }
                    return
                }
                let event: StreamEvent
                switch parsed {
                case .ready(let subscriptionId):
                    subscriptions[id]?.subscriptionId = subscriptionId
                    assembling = nil
                    event = .started
                case .message(let subscriptionId, let message):
                    try requireSubscription(id, subscriptionId)
                    event = .message(message)
                case .part(let subscriptionId, let text, let isFinal):
                    try requireSubscription(id, subscriptionId)
                    var joined = assembling ?? Data()
                    joined.append(text)
                    guard joined.count <= limits.streamMessageBytes else {
                        throw LinkError.malformedResponse("stream message over \(limits.streamMessageBytes) bytes")
                    }
                    guard isFinal else {
                        assembling = joined
                        continue
                    }
                    assembling = nil
                    event = .message(joined)
                case .end(_, let error):
                    if let error {
                        Diagnostics.link.error("subscription \(subscription.stream, privacy: .public) ended: \(error.code, privacy: .public) \(error.message, privacy: .public)")
                    }
                    finishSubscription(id, error: error.map(LinkError.rpc))
                    return
                }
                switch subscription.buffer.push(event) {
                case .delivered: continue
                case .overflowed:
                    Diagnostics.link.notice("subscription \(subscription.stream, privacy: .public) overflowed its reader; subscribing again")
                    return restart(id, on: channel)
                case .closed: return
                }
            }
            if !Task.isCancelled { finishSubscription(id, error: nil) }
        } catch LinkError.disconnected {
            // Kept; resubscribed when the next connection is published.
        } catch is StreamOverflow {
            Diagnostics.link.notice("subscription \(subscription.stream, privacy: .public) overflowed the channel; subscribing again")
            restart(id, on: channel)
        } catch {
            Diagnostics.link.error("subscription \(subscription.stream, privacy: .public) failed: \(String(describing: error), privacy: .public)")
            if !Task.isCancelled { finishSubscription(id, error: error) }
        }
    }

    private func requireSubscription(_ id: UUID, _ subscriptionId: String) throws {
        guard subscriptionId == subscriptions[id]?.subscriptionId else {
            throw LinkError.malformedResponse("message for subscription \(subscriptionId)")
        }
    }

    /// The reader fell behind: release the server's subscription and subscribe
    /// again, so the reader continues from `.started` and a fresh snapshot.
    private func restart(_ id: UUID, on channel: LinkChannel) {
        guard subscriptions[id] != nil else { return }
        if let subscriptionId = subscriptions[id]?.subscriptionId { release(subscriptionId, on: channel) }
        subscriptions[id]?.subscriptionId = nil
        guard self.channel === channel else { return }  // the next connection resubscribes
        startPump(id, on: channel)
    }

    private func release(_ subscriptionId: String, on channel: LinkChannel) {
        let params = try! RPCCoding.encode(["subscriptionId": subscriptionId])
        let timeout = timing.requestTimeout
        Task { _ = try? await channel.request(method: "subscribe.unsubscribe", params: params, timeout: timeout) }
    }

    private func finishSubscription(_ id: UUID, error: Error?) {
        guard let subscription = subscriptions.removeValue(forKey: id) else { return }
        subscription.buffer.finish(throwing: error)
    }

    private func unsubscribe(_ id: UUID) {
        guard let subscription = subscriptions.removeValue(forKey: id) else { return }
        // Before `ready` the host's id is unknown: the pump keeps reading and releases
        // the host's subscription when it arrives.
        guard let subscriptionId = subscription.subscriptionId else { return }
        subscription.pump?.cancel()
        guard let channel else { return }
        release(subscriptionId, on: channel)
    }
}

private struct CapabilitiesUpdate: Encodable {
    let clientCapabilities: [String]
    let apiGeneration: Int
}

private struct CapabilitiesResult: Decodable {
    let capabilities: [String]?
}

/// The results of a `subscribe` call (§4.1): `{type:"ready",subscriptionId}`,
/// then `{type:"message",subscriptionId,data}` per stream message (or, for one
/// too large for a reply, `{type:"part",subscriptionId,text,final}` whose texts
/// join to it), and `{type:"end",subscriptionId,error?}` when the server ends it.
enum SubscriptionResult: Equatable {
    case ready(subscriptionId: String)
    case message(subscriptionId: String, Data)
    case part(subscriptionId: String, text: Data, isFinal: Bool)
    case end(subscriptionId: String, error: RPCError?)

    init(_ json: Data) throws {
        guard let object = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any], let type = object["type"] as? String else {
            throw LinkError.malformedResponse("subscription result")
        }
        guard let id = object["subscriptionId"] as? String, !id.isEmpty else { throw LinkError.malformedResponse("subscriptionId") }
        switch type {
        case "ready":
            self = .ready(subscriptionId: id)
        case "message":
            guard let value = object["data"] else { throw LinkError.malformedResponse("data") }
            self = .message(subscriptionId: id, try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes]))
        case "part":
            guard let text = object["text"] as? String, let isFinal = object["final"] as? Bool else { throw LinkError.malformedResponse("part") }
            self = .part(subscriptionId: id, text: Data(text.utf8), isFinal: isFinal)
        case "end":
            var error: RPCError?
            if let detail = object["error"] as? [String: Any] {
                guard let code = detail["code"] as? String else { throw LinkError.malformedResponse("end error") }
                error = RPCError(code: code, message: detail["message"] as? String ?? "")
            }
            self = .end(subscriptionId: id, error: error)
        default:
            throw LinkError.malformedResponse("subscription result type \(type)")
        }
    }
}
