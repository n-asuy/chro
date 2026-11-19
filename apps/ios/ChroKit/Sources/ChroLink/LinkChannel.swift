import Foundation

/// Why an authenticated channel ended.
enum ChannelEnd: Equatable, Sendable {
    /// The phone closed it (stop, watchdog, reconnect).
    case local
    /// The socket ended from the other side or the network.
    case socket(SocketClosed)
    /// The host answered a request with `unauthorized`: counts as a rejection.
    case rejected
    /// Five frames in a row did not open.
    case tooManyDecryptionFailures

    var isRejection: Bool { self == .rejected }
}

/// The answer to one call: a text result (JSON), or a body the host sent in binary frames.
enum ChannelReply: Equatable, Sendable {
    case text(Data)
    case binary(BinaryReply)
}

/// The link's memory bounds (architecture doc §20).
public struct LinkLimits: Sendable, Equatable {
    /// Bytes admitted to the outbox and not yet taken by the socket writer. A single
    /// larger item (an upload) is admitted alone into an empty outbox.
    public var maxQueuedBytes = 4 * 1024 * 1024
    /// `request` calls admitted and not yet answered: the host runs at most this many
    /// per connection and refuses more with `runtime_busy` (architecture doc §4.1), so
    /// further requests wait here for a slot. Other methods (the liveness probe,
    /// unsubscribe) never wait for one.
    public var maxConcurrentRequests = 8
    /// Events one subscription holds for a slow reader; past either bound the
    /// subscription starts over from a fresh snapshot.
    public var subscriptionEvents = 2_048
    public var subscriptionBytes = 8 * 1024 * 1024
    /// Largest stream message joined from parts (the host's own bound, §4.1).
    public var streamMessageBytes = 64 * 1024 * 1024

    public init() {}
}

/// What the outbox holds (for tests and diagnostics).
struct OutboxLoad: Equatable, Sendable {
    var queuedBytes: Int
    /// `request` calls holding a slot.
    var requests: Int
    /// Items waiting for room.
    var waiting: Int
}

/// A stream's responses arrived faster than its reader took them.
struct StreamOverflow: Error {}

/// One authenticated E2EE v2 socket: sends requests in order, opens frames under
/// strict counters, and routes responses (text, or reassembled binary frames) by id.
///
/// Requests wait in a bounded outbox as plaintext and are sealed only when the
/// writer takes them for the socket, so a request that expires or is cancelled
/// before it is sent leaves no gap in the E2EE counters. A call waits for room
/// (queued bytes, pending calls) within its own timeout.
actor LinkChannel {
    static let maxConsecutiveDecryptionFailures = 5
    /// The host listener's message limit; a larger frame would close the connection.
    static let maxOutboundMessageBytes = 1024 * 1024
    /// The host's cap on one upload (`MAX_IMAGE_UPLOAD_BYTES`).
    static let maxUploadBytes = 20 * 1024 * 1024

    private let socket: any LinkSocket
    private var sealer: FrameSealer
    private var opener: FrameOpener
    private let deviceToken: String
    private let clock: any LinkClock
    private let limits: LinkLimits

    /// One request's frames, unsealed.
    private struct Outgoing {
        let id: String
        /// A `request` holds a slot until it is answered.
        let holdsSlot: Bool
        let frames: [(kind: FrameKind, payload: Data)]
        var bytes: Int { frames.reduce(0) { $0 + $1.payload.count } }
    }

    /// Waiting for room, in order.
    private var admission: [Outgoing] = []
    /// Admitted, waiting for the writer, in order.
    private var queue: [Outgoing] = []
    private var queuedBytes = 0
    /// Admitted `request`s not yet answered.
    private var slots: Set<String> = []
    /// Items ever queued (for tests that need a deterministic order).
    private(set) var enqueuedCount = 0
    private var writerWaiter: CheckedContinuation<[LinkMessage]?, Never>?
    private var writer: Task<Void, Never>?
    private var reader: Task<Void, Never>?

    private var requestCount = 0
    private var pending: [String: CheckedContinuation<ChannelReply, Error>] = [:]
    private var timers: [String: Task<Void, Never>] = [:]
    private var streams: [String: AsyncThrowingStream<Data, Error>.Continuation] = [:]
    private var assemblies: [String: BinaryReplyAssembly] = [:]
    private var decryptionFailures = 0
    private(set) var lastReceived: Duration
    private(set) var end: ChannelEnd?
    private var endWaiters: [CheckedContinuation<ChannelEnd, Never>] = []

    init(socket: any LinkSocket, sealer: FrameSealer, opener: FrameOpener, deviceToken: String, clock: any LinkClock, limits: LinkLimits = LinkLimits()) {
        self.socket = socket
        self.sealer = sealer
        self.opener = opener
        self.deviceToken = deviceToken
        self.clock = clock
        self.limits = limits
        self.lastReceived = clock.now()
        Task { await self.start() }
    }

    private func start() {
        guard end == nil else { return }
        let socket = self.socket
        writer = Task {
            while let messages = await self.nextMessages() {
                do {
                    for message in messages { try await socket.send(message) }
                } catch {
                    self.finish(.socket(error as? SocketClosed ?? SocketClosed(code: 1006, reason: "\(error)", remote: false)))
                    return
                }
            }
        }
        reader = Task {
            while true {
                do {
                    let message = try await socket.receive()
                    self.handle(message)
                } catch {
                    self.finish(.socket(error as? SocketClosed ?? SocketClosed(code: 1006, reason: "\(error)", remote: false)))
                    return
                }
            }
        }
    }

    // MARK: Requests

    /// Sends one request and waits for its text result. `id` is `rpc-<n>-<ms>`.
    func request(method: String, params: Data, timeout: Duration) async throws -> Data {
        switch try await call(method: method, params: params, timeout: timeout) {
        case .text(let result): return result
        case .binary: throw LinkError.malformedResponse("\(method) answered in binary frames")
        }
    }

    /// Sends one request and waits for its reply, text or binary.
    func call(method: String, params: Data, timeout: Duration) async throws -> ChannelReply {
        try await exchange(timeout: timeout, holdsSlot: method == "request") { id in
            [(.text, try self.textPayload(RPCWire.request(id: id, deviceToken: self.deviceToken, method: method, params: params)))]
        }
    }

    /// Sends a `request` whose body is `body`, in binary frames, and waits for the reply.
    func upload(params: Data, body: Data, timeout: Duration) async throws -> ChannelReply {
        guard body.count <= Self.maxUploadBytes else { throw LinkError.requestTooLarge }
        return try await exchange(timeout: timeout, holdsSlot: true) { id in
            try BinaryFrame.uploadFrames(id: id, deviceToken: self.deviceToken, params: params, body: body).map { (.binary, $0) }
        }
    }

    /// Queues the frames `build` makes for a fresh id and waits for the reply under
    /// that id. `timeout` covers waiting for room, for the socket and for the answer.
    private func exchange(timeout: Duration, holdsSlot: Bool, build: (String) throws -> [(kind: FrameKind, payload: Data)]) async throws -> ChannelReply {
        guard end == nil else { throw LinkError.disconnected }
        let id = nextId()
        let frames = try build(id)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<ChannelReply, Error>) in
                guard end == nil else {
                    continuation.resume(throwing: LinkError.disconnected)
                    return
                }
                pending[id] = continuation
                timers[id] = Task { [clock] in
                    guard (try? await clock.sleep(for: timeout)) != nil else { return }
                    self.failPending(id, LinkError.timeout)
                }
                enqueue(Outgoing(id: id, holdsSlot: holdsSlot, frames: frames))
            }
        } onCancel: {
            Task { await self.failPending(id, CancellationError()) }
        }
    }

    /// Sends a request whose responses stream (`streaming:true`) until a final
    /// response, an error, or the channel's end. Returns the request id. A reader
    /// that falls `limits.subscriptionEvents` behind ends the stream with `StreamOverflow`.
    func openStream(method: String, params: Data) throws -> (id: String, responses: AsyncThrowingStream<Data, Error>) {
        guard end == nil else { throw LinkError.disconnected }
        let id = nextId()
        let payload = try textPayload(RPCWire.request(id: id, deviceToken: deviceToken, method: method, params: params))
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream(bufferingPolicy: .bufferingOldest(limits.subscriptionEvents))
        streams[id] = continuation
        continuation.onTermination = { _ in Task { await self.dropStream(id) } }
        enqueue(Outgoing(id: id, holdsSlot: false, frames: [(.text, payload)]))
        return (id, stream)
    }

    private func nextId() -> String {
        requestCount += 1
        return "rpc-\(requestCount)-\(Int64(Date().timeIntervalSince1970 * 1000))"
    }

    /// A text request, refused when its sealed frame could not fit the host's message limit.
    private func textPayload(_ payload: Data) throws -> Data {
        // base64 of nonce ‖ secretbox(header ‖ payload)
        let encoded = (payload.count + Framing.overheadBytes + 2) / 3 * 4
        guard encoded <= Self.maxOutboundMessageBytes else { throw LinkError.requestTooLarge }
        return payload
    }

    // MARK: Outbox

    var outboxLoad: OutboxLoad {
        OutboxLoad(queuedBytes: queuedBytes, requests: slots.count, waiting: admission.count)
    }

    private func enqueue(_ item: Outgoing) {
        enqueuedCount += 1
        admission.append(item)
        admit()
    }

    /// Moves waiting items into the outbox in order while there are bytes for them,
    /// and wakes the writer. A request without a free slot keeps waiting and lets
    /// later items pass; bytes are admitted strictly in order.
    private func admit() {
        var index = 0
        while index < admission.count {
            let next = admission[index]
            if next.holdsSlot, slots.count >= limits.maxConcurrentRequests {
                index += 1
                continue
            }
            if !queue.isEmpty, queuedBytes + next.bytes > limits.maxQueuedBytes { break }
            admission.remove(at: index)
            if next.holdsSlot { slots.insert(next.id) }
            queue.append(next)
            queuedBytes += next.bytes
        }
        if let waiter = writerWaiter, !queue.isEmpty {
            writerWaiter = nil
            if let messages = takeNext() {
                waiter.resume(returning: messages)
            } else {
                writerWaiter = waiter
            }
        }
    }

    /// The writer's next frames, sealed now so counters reach the wire in order;
    /// nil once the channel has ended.
    private func nextMessages() async -> [LinkMessage]? {
        if let messages = takeNext() { return messages }
        guard end == nil else { return nil }
        return await withCheckedContinuation { writerWaiter = $0 }
    }

    private func takeNext() -> [LinkMessage]? {
        while !queue.isEmpty {
            let item = queue.removeFirst()
            queuedBytes -= item.bytes
            do {
                let messages = try item.frames.map { try sealed($0.kind, $0.payload) }
                admit()
                return messages
            } catch {
                failPending(item.id, error)
            }
        }
        return nil
    }

    /// Removes an item that has not reached the writer; it never gets a counter.
    private func withdraw(_ id: String) {
        slots.remove(id)
        admission.removeAll { $0.id == id }
        if let index = queue.firstIndex(where: { $0.id == id }) {
            queuedBytes -= queue.remove(at: index).bytes
        }
    }

    private func sealed(_ kind: FrameKind, _ payload: Data) throws -> LinkMessage {
        let frame = try sealer.seal(kind: kind, payload: payload)
        switch kind {
        case .text: return .text(frame.base64EncodedString())
        case .binary: return .binary(frame)
        }
    }

    private func failPending(_ id: String, _ error: Error) {
        timers.removeValue(forKey: id)?.cancel()
        assemblies.removeValue(forKey: id)
        withdraw(id)
        pending.removeValue(forKey: id)?.resume(throwing: error)
        admit()
    }

    private func resolvePending(_ id: String, _ reply: ChannelReply) {
        timers.removeValue(forKey: id)?.cancel()
        assemblies.removeValue(forKey: id)
        withdraw(id)
        pending.removeValue(forKey: id)?.resume(returning: reply)
        admit()
    }

    private func dropStream(_ id: String) {
        streams.removeValue(forKey: id)
        withdraw(id)
        admit()
    }

    // MARK: Inbound

    private func handle(_ message: LinkMessage) {
        guard end == nil else { return }
        let payload: Data
        do {
            switch message {
            case .text(let text):
                payload = try opener.open(kind: .text, frame: try CanonicalBase64.decode(text))
            case .binary(let data):
                payload = try opener.open(kind: .binary, frame: data)
            }
        } catch {
            decryptionFailures += 1
            if decryptionFailures >= Self.maxConsecutiveDecryptionFailures {
                socket.close(code: CloseCode.tooManyDecryptionFailures, reason: "Too many decryption failures")
                finish(.tooManyDecryptionFailures)
            }
            return
        }
        decryptionFailures = 0
        lastReceived = clock.now()
        switch message {
        case .binary:
            receiveBinary(payload)
        case .text:
            guard let response = try? RPCWire.response(payload) else { return }
            route(response)
        }
    }

    /// One frame of a binary reply. Frames for calls no longer waiting (timed
    /// out, cancelled) are dropped; a broken sequence fails its call.
    private func receiveBinary(_ payload: Data) {
        guard let (header, chunk) = try? BinaryFrame.decode(payload),
              let id = header["id"] as? String, pending[id] != nil,
              let seq = header["seq"] as? Int, let isFinal = header["final"] as? Bool
        else { return }
        do {
            var assembly: BinaryReplyAssembly
            if seq == 0 {
                guard assemblies[id] == nil else { throw LinkError.malformedResponse("binary reply \(id) restarted") }
                assembly = try BinaryReplyAssembly(first: header, chunk: chunk)
            } else {
                guard let started = assemblies[id] else { throw LinkError.malformedResponse("binary reply \(id) without its first frame") }
                assembly = started
                try assembly.append(seq: seq, chunk: chunk, isFinal: isFinal)
            }
            if let reply = assembly.reply {
                resolvePending(id, .binary(reply))
            } else {
                assemblies[id] = assembly
            }
        } catch {
            failPending(id, error)
        }
    }

    private func route(_ response: RPCWire.Response) {
        if case .failure(let error) = response.outcome, error.code == RPCError.unauthorizedCode {
            // The host no longer accepts this token: fail this call, end the channel, count a rejection.
            deliver(response)
            socket.close(code: CloseCode.normal, reason: "Unauthorized")
            finish(.rejected)
            return
        }
        deliver(response)
    }

    private func deliver(_ response: RPCWire.Response) {
        if pending[response.id] != nil {
            switch response.outcome {
            case .success(let data): resolvePending(response.id, .text(data))
            case .failure(let error): failPending(response.id, LinkError.rpc(error))
            }
            return
        }
        guard let stream = streams[response.id] else { return }
        switch response.outcome {
        case .success(let data):
            if case .dropped = stream.yield(data) {
                streams.removeValue(forKey: response.id)
                stream.finish(throwing: StreamOverflow())
                return
            }
            if !response.streaming {
                streams.removeValue(forKey: response.id)
                stream.finish()
            }
        case .failure(let error):
            streams.removeValue(forKey: response.id)
            stream.finish(throwing: LinkError.rpc(error))
        }
    }

    // MARK: End

    /// Closes the socket and ends the channel; in-flight calls fail with `.disconnected`.
    func close(code: Int = CloseCode.normal, reason: String = "Client closed") {
        guard end == nil else { return }
        socket.close(code: code, reason: reason)
        finish(.local)
    }

    /// Waits until the channel has ended and returns why.
    func ended() async -> ChannelEnd {
        if let end { return end }
        return await withCheckedContinuation { endWaiters.append($0) }
    }

    private func finish(_ reason: ChannelEnd) {
        guard end == nil else { return }
        end = reason
        socket.close(code: CloseCode.normal, reason: "Closed")
        admission.removeAll()
        queue.removeAll()
        queuedBytes = 0
        slots.removeAll()
        writerWaiter?.resume(returning: nil)
        writerWaiter = nil
        reader?.cancel()
        writer?.cancel()
        for (id, continuation) in pending {
            timers.removeValue(forKey: id)?.cancel()
            continuation.resume(throwing: LinkError.disconnected)
        }
        pending.removeAll()
        assemblies.removeAll()
        for stream in streams.values { stream.finish(throwing: LinkError.disconnected) }
        streams.removeAll()
        for waiter in endWaiters { waiter.resume(returning: reason) }
        endWaiters.removeAll()
    }
}
