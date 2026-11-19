import Foundation

/// The events of one subscription, as its reader takes them. The buffer between
/// the link and the reader is bounded (`LinkLimits.subscriptionEvents` and
/// `subscriptionBytes`): a reader that falls behind loses the buffered events and
/// the link subscribes again, so the reader's next event is `.started` followed
/// by a fresh snapshot. Dropping single patches instead would corrupt the state
/// built from them.
///
/// Ending the iteration, cancelling the reading task or releasing the sequence
/// and its iterators unsubscribes.
public struct LinkSubscription: AsyncSequence, Sendable {
    public typealias Element = StreamEvent

    let buffer: SubscriptionBuffer
    private let lease: ReaderLease

    init(buffer: SubscriptionBuffer) {
        self.buffer = buffer
        lease = ReaderLease(buffer)
    }

    public func makeAsyncIterator() -> Iterator { Iterator(buffer: buffer, lease: lease) }

    public struct Iterator: AsyncIteratorProtocol {
        let buffer: SubscriptionBuffer
        let lease: ReaderLease

        public mutating func next() async throws -> StreamEvent? { try await buffer.next() }
    }
}

/// Ends the subscription once the sequence and all its iterators are gone.
final class ReaderLease: Sendable {
    private let buffer: SubscriptionBuffer
    init(_ buffer: SubscriptionBuffer) { self.buffer = buffer }
    deinit { buffer.terminate() }
}

/// The bounded queue behind a `LinkSubscription`.
final class SubscriptionBuffer: @unchecked Sendable {
    enum Push: Equatable {
        case delivered
        /// The reader is too far behind: everything buffered was dropped.
        case overflowed
        /// The reader is gone or the subscription has ended.
        case closed
    }

    private let lock = NSLock()
    private let maxEvents: Int
    private let maxBytes: Int
    private var events: [StreamEvent] = []
    private var head = 0
    private var bytes = 0
    private var waiter: CheckedContinuation<StreamEvent?, Error>?
    /// Set by `finish`: the end the reader sees after the buffered events.
    private var ending: Result<Void, Error>?
    private var terminated = false
    private var onTermination: (@Sendable () -> Void)?

    init(maxEvents: Int, maxBytes: Int) {
        self.maxEvents = maxEvents
        self.maxBytes = maxBytes
    }

    /// Called once when the reader goes away (not when the link finishes the subscription).
    func onReaderGone(_ action: @escaping @Sendable () -> Void) {
        let runNow = lock.withLock { () -> Bool in
            guard !terminated else { return true }
            onTermination = action
            return false
        }
        if runNow { action() }
    }

    var count: Int { lock.withLock { events.count - head } }

    func push(_ event: StreamEvent) -> Push {
        let size = Self.size(event)
        let outcome = lock.withLock { () -> (Push, CheckedContinuation<StreamEvent?, Error>?) in
            guard !terminated, ending == nil else { return (.closed, nil) }
            if let waiter {
                self.waiter = nil
                return (.delivered, waiter)
            }
            let buffered = events.count - head
            // One message is always admitted past the byte bound (a snapshot larger than
            // it would otherwise start over forever); `.started` holds no bytes.
            if buffered >= maxEvents || (bytes > 0 && bytes + size > maxBytes) {
                events.removeAll()
                head = 0
                bytes = 0
                return (.overflowed, nil)
            }
            events.append(event)
            bytes += size
            return (.delivered, nil)
        }
        outcome.1?.resume(returning: event)
        return outcome.0
    }

    /// The link ended the subscription: the reader gets the buffered events, then the end.
    func finish(throwing error: Error? = nil) {
        let waiter = lock.withLock { () -> CheckedContinuation<StreamEvent?, Error>? in
            guard ending == nil, !terminated else { return nil }
            ending = error.map { .failure($0) } ?? .success(())
            guard events.count == head, let waiter = self.waiter else { return nil }
            self.waiter = nil
            ending = .success(())
            return waiter
        }
        if let error { waiter?.resume(throwing: error) } else { waiter?.resume(returning: nil) }
    }

    func next() async throws -> StreamEvent? {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<StreamEvent?, Error>) in
                lock.lock()
                if head < events.count {
                    let event = events[head]
                    head += 1
                    bytes -= Self.size(event)
                    if head == events.count {
                        events.removeAll(keepingCapacity: true)
                        head = 0
                    }
                    lock.unlock()
                    continuation.resume(returning: event)
                } else if let ending {
                    // The end is delivered once; later calls return nil.
                    self.ending = .success(())
                    lock.unlock()
                    switch ending {
                    case .success: continuation.resume(returning: nil)
                    case .failure(let error): continuation.resume(throwing: error)
                    }
                } else if terminated || Task.isCancelled {
                    lock.unlock()
                    continuation.resume(returning: nil)
                    terminate()
                } else {
                    precondition(waiter == nil, "one reader at a time")
                    waiter = continuation
                    lock.unlock()
                }
            }
        } onCancel: {
            terminate()
        }
    }

    /// The reader is gone: drop everything and tell the link once.
    func terminate() {
        let (waiter, action) = lock.withLock { () -> (CheckedContinuation<StreamEvent?, Error>?, (@Sendable () -> Void)?) in
            guard !terminated else { return (nil, nil) }
            terminated = true
            events.removeAll()
            head = 0
            bytes = 0
            defer {
                self.waiter = nil
                onTermination = nil
            }
            return (self.waiter, ending == nil ? onTermination : nil)
        }
        waiter?.resume(returning: nil)
        action?()
    }

    private static func size(_ event: StreamEvent) -> Int {
        switch event {
        case .started: 0
        case .message(let data): data.count
        }
    }
}
