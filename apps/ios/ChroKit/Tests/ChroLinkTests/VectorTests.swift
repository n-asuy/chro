import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// Every value of crates/mobile-link/testdata/e2ee-v2-vectors.json, reproduced byte for byte.
struct VectorTests {
    let vectors: Vectors

    init() throws { vectors = try Vectors.load() }

    private func context(_ context: Vectors.Context) -> HandshakeContext {
        #expect(context.protocol == E2EELabels.protocolName)
        switch context.transport {
        case "direct":
            #expect(context.relayHostId == nil)
            return .direct
        case "relay": return .relay(hostId: context.relayHostId!)
        default:
            Issue.record("unknown transport \(context.transport)")
            return .direct
        }
    }

    @Test func labelsAreChrosOwn() {
        #expect(vectors.labels.protocol == E2EELabels.protocolName)
        #expect(Data(vectors.labels.transcriptDomain.utf8) == E2EELabels.transcriptDomain)
        #expect(Data(vectors.labels.salt.utf8) == E2EELabels.salt)
        #expect(Data(vectors.labels.session.utf8) == E2EELabels.session)
        #expect(E2EELabels.salt.last == 0)
        #expect(E2EELabels.session.last == 0)
    }

    @Test func keyScheduleOfBothTransports() {
        #expect(vectors.keySchedule.count == 2)
        for schedule in vectors.keySchedule {
            let transcript = Transcript.encode(
                context: context(schedule.context),
                clientPublicKey: Data(hex: schedule.clientPublicKeyHex),
                clientNonce: Data(hex: schedule.clientNonceHex),
                desktopPublicKey: Data(hex: schedule.desktopPublicKeyHex),
                desktopNonce: Data(hex: schedule.desktopNonceHex)
            )
            #expect(transcript.count == schedule.transcriptLength)
            #expect(transcript == Data(hex: schedule.transcriptHex))
            let keys = KeySchedule.derive(
                shared: Data(hex: schedule.sharedHex),
                clientNonce: Data(hex: schedule.clientNonceHex),
                desktopNonce: Data(hex: schedule.desktopNonceHex),
                transcript: transcript
            )
            #expect(keys.transcriptHash == Data(hex: schedule.transcriptHashHex))
            #expect(keys.mobileToDesktopKey == Data(hex: schedule.mobileToDesktopKeyHex))
            #expect(keys.desktopToMobileKey == Data(hex: schedule.desktopToMobileKeyHex))
            #expect(keys.sessionId == Data(hex: schedule.sessionIdHex))
        }
    }

    @Test func endToEndKeysWithRealCurveMaths() throws {
        let e2e = vectors.endToEnd
        let clientSecret = Data(hex: e2e.clientSecretKeyHex)
        let desktopSecret = Data(hex: e2e.desktopSecretKeyHex)
        #expect(try NaCl.publicKey(secretKey: clientSecret) == Data(hex: e2e.clientPublicKeyHex))
        #expect(try NaCl.publicKey(secretKey: desktopSecret) == Data(hex: e2e.desktopPublicKeyHex))
        let phoneShared = try NaCl.boxBeforeNM(publicKey: Data(hex: e2e.desktopPublicKeyHex), secretKey: clientSecret)
        let hostShared = try NaCl.boxBeforeNM(publicKey: Data(hex: e2e.clientPublicKeyHex), secretKey: desktopSecret)
        #expect(phoneShared == Data(hex: e2e.sharedHex))
        #expect(hostShared == phoneShared)

        let transcript = Transcript.encode(
            context: context(e2e.context),
            clientPublicKey: Data(hex: e2e.clientPublicKeyHex),
            clientNonce: Data(hex: e2e.clientNonceHex),
            desktopPublicKey: Data(hex: e2e.desktopPublicKeyHex),
            desktopNonce: Data(hex: e2e.desktopNonceHex)
        )
        let keys = KeySchedule.derive(shared: phoneShared, clientNonce: Data(hex: e2e.clientNonceHex), desktopNonce: Data(hex: e2e.desktopNonceHex), transcript: transcript)
        #expect(keys.transcriptHash == Data(hex: e2e.transcriptHashHex))
        #expect(keys.mobileToDesktopKey == Data(hex: e2e.mobileToDesktopKeyHex))
        #expect(keys.desktopToMobileKey == Data(hex: e2e.desktopToMobileKeyHex))
        #expect(keys.sessionId == Data(hex: e2e.sessionIdHex))
    }

    @Test func authPayloadIsTheVectorsFirstFrame() throws {
        let e2e = vectors.endToEnd
        let payload = HandshakeMessages.auth(transcriptHash: Data(hex: e2e.transcriptHashHex), deviceToken: String(repeating: "a", count: 48))
        #expect(payload == e2e.frames[0].payload)
    }

    @Test func framesSealAndOpenAsTheVectorsSay() throws {
        let e2e = vectors.endToEnd
        let keys = SessionKeys(
            mobileToDesktopKey: Data(hex: e2e.mobileToDesktopKeyHex),
            desktopToMobileKey: Data(hex: e2e.desktopToMobileKeyHex),
            sessionId: Data(hex: e2e.sessionIdHex),
            transcriptHash: Data(hex: e2e.transcriptHashHex)
        )
        // The phone seals what it sends and opens what the host sends; the host side is the mirror.
        var phoneSealer = FrameSealer(keys: keys, direction: .mobileToDesktop)
        var phoneOpener = FrameOpener(keys: keys, direction: .desktopToMobile)
        var hostSealer = FrameSealer(keys: keys, direction: .desktopToMobile)
        var hostOpener = FrameOpener(keys: keys, direction: .mobileToDesktop)
        #expect(e2e.frames.count == 3)
        for frame in e2e.frames {
            let kind = try #require(FrameKind(rawValue: frame.kind))
            let direction = try #require(FrameDirection(rawValue: frame.direction))
            let expected = Data(hex: frame.frameHex)
            if direction == .mobileToDesktop {
                #expect(phoneSealer.nextCounter == frame.counter)
                #expect(try phoneSealer.seal(kind: kind, payload: frame.payload) == expected)
                #expect(try hostOpener.open(kind: kind, frame: expected) == frame.payload)
            } else {
                #expect(hostSealer.nextCounter == frame.counter)
                #expect(try hostSealer.seal(kind: kind, payload: frame.payload) == expected)
                #expect(try phoneOpener.open(kind: kind, frame: expected) == frame.payload)
            }
            if let b64 = frame.frameB64 {
                #expect(expected.base64EncodedString() == b64)
                #expect(try CanonicalBase64.decode(b64) == expected)
            }
            #expect(expected.count == frame.payload.count + vectors.frameOverheadBytes)
        }
    }

    @Test func nonceLayout() throws {
        let nonce = vectors.nonce
        let direction = try #require(FrameDirection(rawValue: nonce.direction))
        let kind = try #require(FrameKind(rawValue: nonce.kind))
        #expect(Framing.nonce(sessionId: Data(hex: nonce.sessionIdHex), direction: direction, kind: kind, counter: nonce.counter) == Data(hex: nonce.nonceHex))
    }

    @Test func overhead() {
        #expect(Framing.overheadBytes == vectors.frameOverheadBytes)
    }
}
