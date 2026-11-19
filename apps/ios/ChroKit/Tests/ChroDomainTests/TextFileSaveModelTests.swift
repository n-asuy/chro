@testable import ChroDomain
import Foundation
import Testing

/// A save delay the test releases by hand.
@MainActor
final class ManualDelay {
    private var waiters: [CheckedContinuation<Void, Error>] = []
    var pending: Int { waiters.count }

    func sleep(_: Duration) async throws {
        try await withCheckedThrowingContinuation { waiters.append($0) }
    }

    func fire() {
        let all = waiters
        waiters = []
        all.forEach { $0.resume() }
    }
}

@MainActor
final class WriteLog {
    var writes: [String] = []
    var failNext: Error?
    var gate: CheckedContinuation<Void, Never>?
    var holds = false

    func write(_ text: String) async throws {
        writes.append(text)
        if holds { await withCheckedContinuation { gate = $0 } }
        if let failure = failNext {
            failNext = nil
            throw failure
        }
    }

    func release() {
        holds = false
        gate?.resume()
        gate = nil
    }
}

struct WriteFailure: Error, LocalizedError { var errorDescription: String? { "disk full" } }

@MainActor
@Suite struct TextFileSaveModelTests {
    private func settle() async { for _ in 0..<20 { await Task.yield() } }

    @Test func firstEditSchedulesOneSaveAndLaterEditsDoNotPushItBack() async {
        let delay = ManualDelay(), log = WriteLog()
        let model = TextFileSaveModel(write: log.write, sleep: delay.sleep)
        _ = model.applyDisk("a")
        model.setViewData("ab")
        await settle()
        #expect(delay.pending == 1)
        model.setViewData("abc")
        await settle()
        #expect(delay.pending == 1)
        #expect(model.unsaved)
        delay.fire()
        await settle()
        #expect(log.writes == ["abc"])
        #expect(!model.unsaved)
        #expect(model.idle)
    }

    @Test func defaultDelayIsTwoSeconds() {
        #expect(TextFileSaveModel.saveDelay == .milliseconds(2000))
    }

    @Test func flushWritesImmediately() async {
        let delay = ManualDelay(), log = WriteLog()
        let model = TextFileSaveModel(write: log.write, sleep: delay.sleep)
        _ = model.applyDisk("a")
        model.setViewData("b")
        await model.settled()
        #expect(log.writes == ["b"])
        #expect(!model.unsaved)
    }

    @Test func editDuringWriteQueuesExactlyOneFollowUp() async {
        let delay = ManualDelay(), log = WriteLog()
        let model = TextFileSaveModel(write: log.write, sleep: delay.sleep)
        _ = model.applyDisk("a")
        log.holds = true
        model.setViewData("b")
        let first = Task { await model.save() }
        await settle()
        #expect(model.saving)
        model.setViewData("c")
        model.setViewData("d")
        let second = Task { await model.save() }
        await settle()
        log.release()
        await first.value
        await second.value
        await model.settled()
        #expect(log.writes == ["b", "d"])
        #expect(!model.unsaved)
    }

    @Test func failedWriteKeepsTextUnsavedAndReports() async {
        let delay = ManualDelay(), log = WriteLog()
        var reported: String?
        let model = TextFileSaveModel(write: log.write, sleep: delay.sleep) { reported = $0.localizedDescription }
        _ = model.applyDisk("a")
        log.failNext = WriteFailure()
        model.setViewData("b")
        await model.settled()
        #expect(model.unsaved)
        #expect(reported == "disk full")
    }

    @Test func diskReadReplacesCleanTextAndMergesUnsavedText() {
        let model = TextFileSaveModel(write: { _ in }, sleep: { _ in try await Task.sleep(for: .seconds(60)) })
        #expect(model.applyDisk("one\ntwo\nthree") == .init(text: "one\ntwo\nthree", merged: false))
        #expect(model.applyDisk("one\n2\nthree") == .init(text: "one\n2\nthree", merged: false))
        model.setViewData("one\n2\nthree\nfour")
        let merged = model.applyDisk("zero\none\n2\nthree")
        #expect(merged == .init(text: "zero\none\n2\nthree\nfour", merged: true))
        #expect(model.text == "zero\none\n2\nthree\nfour")
    }

    @Test func sameDiskTextIsNoChange() {
        let model = TextFileSaveModel(write: { _ in }, sleep: { _ in })
        _ = model.applyDisk("x")
        #expect(model.applyDisk("x") == nil)
    }
}

@Suite struct TextMergeTests {
    @Test func nonOverlappingEditsBothLand() {
        #expect(TextMerge.merge(base: "a\nb\nc\nd", mine: "a\nB\nc\nd", theirs: "a\nb\nc\nD") == "a\nB\nc\nD")
    }

    @Test func overlappingEditKeepsMine() {
        #expect(TextMerge.merge(base: "a\nb\nc", mine: "a\nmine\nc", theirs: "a\ntheirs\nc") == "a\nmine\nc")
    }

    @Test func unchangedSidesPassThrough() {
        #expect(TextMerge.merge(base: "a", mine: "a", theirs: "b") == "b")
        #expect(TextMerge.merge(base: "a", mine: "b", theirs: "a") == "b")
    }

    @Test func insertionsAtTheSamePointKeepBoth() {
        #expect(TextMerge.merge(base: "a\nz", mine: "a\nm\nz", theirs: "a\nt\nz") == "a\nt\nm\nz")
    }
}
