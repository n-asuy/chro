import Foundation
import Testing
@testable import ChroServices

/// `ServiceBroadcast` delivers whole-state snapshots: in mutation order, and
/// only the newest one to a reader that has fallen behind.
@Suite(.timeLimit(.minutes(1)))
struct ServiceBroadcastTests {
    /// Runs `body` on another thread and waits for it to return.
    private static func onAnotherThread(_ body: @escaping @Sendable () -> Void) {
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            body()
            done.signal()
        }
        done.wait()
    }

    @Test func aSubscriberNeverSeesItsFirstSnapshotAfterALaterUpdate() async throws {
        let broadcast = ServiceBroadcast("A")
        // Registration publishes A; before it returns, another thread publishes B.
        broadcast.afterPublishing = {
            broadcast.afterPublishing = nil  // once; also releases the closure's reference
            Self.onAnotherThread { broadcast.update { $0 = "B" } }
        }
        var iterator = broadcast.stream().makeAsyncIterator()
        #expect(await iterator.next() == "B")
        // Nothing stale (A) is queued behind it.
        broadcast.update { $0 = "C" }
        #expect(await iterator.next() == "C")
    }

    @Test func concurrentUpdatesArriveInMutationOrder() async throws {
        let broadcast = ServiceBroadcast(0)
        var iterator = broadcast.stream().makeAsyncIterator()
        #expect(await iterator.next() == 0)
        // Update 1 publishes; before it returns, another thread applies update 2.
        broadcast.afterPublishing = {
            broadcast.afterPublishing = nil  // once; also releases the closure's reference
            Self.onAnotherThread { broadcast.update { $0 = 2 } }
        }
        broadcast.update { $0 = 1 }
        // The reader is behind by two snapshots and gets the newest: never 1 after 2.
        #expect(await iterator.next() == 2)
        broadcast.update { $0 = 3 }
        #expect(await iterator.next() == 3)
    }

    @Test func aSnapshotDerivedEarlierNeverReplacesALaterOne() async throws {
        // Two publishers derive snapshots under their state's lock (revisions 1, 2) and
        // publish outside it: the older one arriving last is dropped.
        let broadcast = ServiceBroadcast("initial")
        var iterator = broadcast.stream().makeAsyncIterator()
        #expect(await iterator.next() == "initial")
        broadcast.publish("second", revision: 2)
        broadcast.publish("first", revision: 1)
        #expect(broadcast.value == "second")
        #expect(await iterator.next() == "second")
        broadcast.publish("third", revision: 3)
        #expect(await iterator.next() == "third")
    }

    @Test func aSlowReaderHoldsOnlyTheNewestSnapshot() async throws {
        let broadcast = ServiceBroadcast(0)
        var iterator = broadcast.stream().makeAsyncIterator()
        for value in 1...1_000 { broadcast.update { $0 = value } }
        #expect(await iterator.next() == 1_000)
    }

    @Test func aReaderThatKeepsUpSeesEveryChange() async throws {
        let broadcast = ServiceBroadcast(0)
        var iterator = broadcast.stream().makeAsyncIterator()
        var seen: [Int] = []
        for value in 0...3 {
            if value > 0 { broadcast.update { $0 = value } }
            seen.append(try #require(await iterator.next()))
        }
        #expect(seen == [0, 1, 2, 3])
    }

    @Test func cancellingReadersWhileUpdatingNeverDeadlocks() async throws {
        // A cancelled reader's termination runs under the runtime's task lock while an
        // update delivers to that reader: neither may wait for the other.
        let broadcast = ServiceBroadcast(0)
        // A plain thread, not the cooperative pool: the loop never suspends.
        let running = Flag(true)
        let stopped = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            var value = 0
            while running.value {
                value += 1
                broadcast.update { $0 = value }
            }
            stopped.signal()
        }
        for _ in 0..<2_000 {
            let reader = Task { for await _ in broadcast.stream() {} }
            await Task.yield()
            reader.cancel()
            _ = await reader.value
        }
        running.value = false
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                stopped.wait()
                continuation.resume()
            }
        }
        #expect(broadcast.subscriberCount == 0)
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Bool
    init(_ value: Bool) { current = value }
    var value: Bool {
        get { lock.withLock { current } }
        set { lock.withLock { current = newValue } }
    }
}
