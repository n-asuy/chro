import Foundation

public enum FrameDirection: UInt8, Sendable {
    case mobileToDesktop = 0
    case desktopToMobile = 1
}

/// Text frames travel base64 in WebSocket text messages, binary frames raw in
/// binary messages; the receiver takes the kind from the WebSocket opcode.
public enum FrameKind: UInt8, Sendable {
    case text = 0
    case binary = 1
}

public enum FrameError: Error, Equatable {
    case tooShort
    /// The nonce is not the one expected for (session, direction, kind, counter).
    case counterMismatch
    case authenticationFailed
    case headerMismatch
    case counterExhausted
}

/// E2EE v2 frame layout (spec §3.5):
/// `nonce(24) ‖ secretbox(header(42) ‖ payload)` with
/// `nonce = sessionId[0..12] ‖ 0x02 ‖ dir ‖ kind ‖ 0x00 ‖ u64be(counter)` and
/// `header = sessionId(32) ‖ dir ‖ kind ‖ u64be(counter)`.
public enum Framing {
    static let version: UInt8 = 2
    static let headerBytes = 32 + 1 + 1 + 8
    public static let overheadBytes = NaCl.secretboxNonceBytes + NaCl.secretboxMacBytes + headerBytes

    public static func nonce(sessionId: Data, direction: FrameDirection, kind: FrameKind, counter: UInt64) -> Data {
        var nonce = Data(sessionId.prefix(12))
        nonce.append(contentsOf: [version, direction.rawValue, kind.rawValue, 0])
        nonce.append(bigEndian(counter))
        return nonce
    }

    static func header(sessionId: Data, direction: FrameDirection, kind: FrameKind, counter: UInt64) -> Data {
        var header = sessionId
        header.append(contentsOf: [direction.rawValue, kind.rawValue])
        header.append(bigEndian(counter))
        return header
    }

    private static func bigEndian(_ value: UInt64) -> Data {
        withUnsafeBytes(of: value.bigEndian) { Data($0) }
    }
}

/// Seals one direction's frames. The counter is consumed per sealed frame, so
/// frames must reach the socket in the order they were sealed.
public struct FrameSealer: Sendable {
    let keys: SessionKeys
    let direction: FrameDirection
    public private(set) var nextCounter: UInt64 = 0

    public init(keys: SessionKeys, direction: FrameDirection) {
        self.keys = keys
        self.direction = direction
    }

    public mutating func seal(kind: FrameKind, payload: Data) throws -> Data {
        guard nextCounter < UInt64.max else { throw FrameError.counterExhausted }
        let counter = nextCounter
        let nonce = Framing.nonce(sessionId: keys.sessionId, direction: direction, kind: kind, counter: counter)
        let plain = Framing.header(sessionId: keys.sessionId, direction: direction, kind: kind, counter: counter) + payload
        let boxed = try NaCl.secretboxSeal(plain, nonce: nonce, key: keys.key(for: direction))
        nextCounter += 1
        return nonce + boxed
    }
}

/// Opens one direction's frames. Only the exact expected counter is accepted and
/// it advances only when a frame opens, which rejects replays, gaps, reflected
/// frames (the other direction's nonce), kind confusion and foreign sessions.
public struct FrameOpener: Sendable {
    let keys: SessionKeys
    let direction: FrameDirection
    public private(set) var expectedCounter: UInt64 = 0

    public init(keys: SessionKeys, direction: FrameDirection) {
        self.keys = keys
        self.direction = direction
    }

    public mutating func open(kind: FrameKind, frame: Data) throws -> Data {
        guard frame.count >= Framing.overheadBytes else { throw FrameError.tooShort }
        guard expectedCounter < UInt64.max else { throw FrameError.counterExhausted }
        let frame = Data(frame)  // rebase indices to zero
        let nonce = Framing.nonce(sessionId: keys.sessionId, direction: direction, kind: kind, counter: expectedCounter)
        guard NaCl.constantTimeEqual(frame.prefix(NaCl.secretboxNonceBytes), nonce) else { throw FrameError.counterMismatch }
        guard let plain = try NaCl.secretboxOpen(frame.dropFirst(NaCl.secretboxNonceBytes), nonce: nonce, key: keys.key(for: direction)) else {
            throw FrameError.authenticationFailed
        }
        let header = Framing.header(sessionId: keys.sessionId, direction: direction, kind: kind, counter: expectedCounter)
        guard NaCl.constantTimeEqual(plain.prefix(Framing.headerBytes), header) else { throw FrameError.headerMismatch }
        expectedCounter += 1
        return Data(plain.dropFirst(Framing.headerBytes))
    }
}
