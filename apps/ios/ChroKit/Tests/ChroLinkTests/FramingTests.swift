import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// Strict per-direction counters: replay, gaps, reflection, kind confusion and
/// frames of another session all fail, and only a successful open advances.
struct FramingTests {
    let keys = SessionKeys(
        mobileToDesktopKey: Data(repeating: 0x11, count: 32),
        desktopToMobileKey: Data(repeating: 0x22, count: 32),
        sessionId: Data(repeating: 0x33, count: 32),
        transcriptHash: Data(repeating: 0x44, count: 32)
    )

    private func hostFrames(_ count: Int, kind: FrameKind = .text) throws -> [Data] {
        var sealer = FrameSealer(keys: keys, direction: .desktopToMobile)
        return try (0..<count).map { try sealer.seal(kind: kind, payload: Data("m\($0)".utf8)) }
    }

    @Test func inOrderFramesOpen() throws {
        let frames = try hostFrames(3)
        var opener = FrameOpener(keys: keys, direction: .desktopToMobile)
        for (index, frame) in frames.enumerated() {
            #expect(try opener.open(kind: .text, frame: frame) == Data("m\(index)".utf8))
        }
        #expect(opener.expectedCounter == 3)
    }

    @Test func replayIsRejected() throws {
        let frames = try hostFrames(1)
        var opener = FrameOpener(keys: keys, direction: .desktopToMobile)
        _ = try opener.open(kind: .text, frame: frames[0])
        #expect(throws: FrameError.counterMismatch) { try opener.open(kind: .text, frame: frames[0]) }
        #expect(opener.expectedCounter == 1)
    }

    @Test func gapIsRejectedAndDoesNotAdvance() throws {
        let frames = try hostFrames(2)
        var opener = FrameOpener(keys: keys, direction: .desktopToMobile)
        #expect(throws: FrameError.counterMismatch) { try opener.open(kind: .text, frame: frames[1]) }
        #expect(opener.expectedCounter == 0)
        // The missing frame still opens afterwards, then the next one.
        _ = try opener.open(kind: .text, frame: frames[0])
        _ = try opener.open(kind: .text, frame: frames[1])
    }

    @Test func reflectionOfOurOwnFrameIsRejected() throws {
        var phoneSealer = FrameSealer(keys: keys, direction: .mobileToDesktop)
        let own = try phoneSealer.seal(kind: .text, payload: Data("hello".utf8))
        var opener = FrameOpener(keys: keys, direction: .desktopToMobile)
        #expect(throws: FrameError.self) { try opener.open(kind: .text, frame: own) }
        #expect(opener.expectedCounter == 0)
    }

    @Test func kindConfusionIsRejected() throws {
        let binary = try hostFrames(1, kind: .binary)
        var opener = FrameOpener(keys: keys, direction: .desktopToMobile)
        #expect(throws: FrameError.self) { try opener.open(kind: .text, frame: binary[0]) }
        #expect(try opener.open(kind: .binary, frame: binary[0]) == Data("m0".utf8))
    }

    @Test func textAndBinaryShareOneCounter() throws {
        var sealer = FrameSealer(keys: keys, direction: .desktopToMobile)
        let text = try sealer.seal(kind: .text, payload: Data("t".utf8))
        let binary = try sealer.seal(kind: .binary, payload: Data([1, 2]))
        var opener = FrameOpener(keys: keys, direction: .desktopToMobile)
        #expect(try opener.open(kind: .text, frame: text) == Data("t".utf8))
        #expect(try opener.open(kind: .binary, frame: binary) == Data([1, 2]))
    }

    @Test func frameOfAnotherSessionIsRejected() throws {
        let other = SessionKeys(mobileToDesktopKey: keys.mobileToDesktopKey, desktopToMobileKey: keys.desktopToMobileKey, sessionId: Data(repeating: 0x55, count: 32), transcriptHash: keys.transcriptHash)
        var sealer = FrameSealer(keys: other, direction: .desktopToMobile)
        let foreign = try sealer.seal(kind: .text, payload: Data("x".utf8))
        var opener = FrameOpener(keys: keys, direction: .desktopToMobile)
        #expect(throws: FrameError.self) { try opener.open(kind: .text, frame: foreign) }
    }

    @Test func wrongKeyIsRejected() throws {
        let other = SessionKeys(mobileToDesktopKey: keys.mobileToDesktopKey, desktopToMobileKey: Data(repeating: 0x66, count: 32), sessionId: keys.sessionId, transcriptHash: keys.transcriptHash)
        var sealer = FrameSealer(keys: other, direction: .desktopToMobile)
        let forged = try sealer.seal(kind: .text, payload: Data("x".utf8))
        var opener = FrameOpener(keys: keys, direction: .desktopToMobile)
        #expect(throws: FrameError.authenticationFailed) { try opener.open(kind: .text, frame: forged) }
    }

    @Test func tamperedFrameIsRejected() throws {
        var frame = try hostFrames(1)[0]
        frame[frame.count - 1] ^= 0x01
        var opener = FrameOpener(keys: keys, direction: .desktopToMobile)
        #expect(throws: FrameError.authenticationFailed) { try opener.open(kind: .text, frame: frame) }
        #expect(opener.expectedCounter == 0)
    }

    @Test func shortFrameIsRejected() {
        var opener = FrameOpener(keys: keys, direction: .desktopToMobile)
        #expect(throws: FrameError.tooShort) { try opener.open(kind: .text, frame: Data(count: Framing.overheadBytes - 1)) }
    }

    @Test func emptyPayloadRoundTrips() throws {
        var sealer = FrameSealer(keys: keys, direction: .desktopToMobile)
        let frame = try sealer.seal(kind: .binary, payload: Data())
        #expect(frame.count == Framing.overheadBytes)
        var opener = FrameOpener(keys: keys, direction: .desktopToMobile)
        #expect(try opener.open(kind: .binary, frame: frame) == Data())
    }
}
