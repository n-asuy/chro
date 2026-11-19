import Foundation
import Testing
@testable import ChroAPI

/// Wire shapes mirror crates/server-contract (envelope.rs, error.rs, api.rs).
struct EnvelopeTests {
    @Test func successEnvelopeYieldsItsResult() throws {
        let json = #"{"ok":true,"result":{"projects":[{"id":"97984c0f-7106-4b8d-8aa2-689412a99638","slug":"97984c0f","name":"chro-orig","path":"/repo"}]},"meta":{"runtime_id":"rt","contract_rev":"0.1.0+8133f219"}}"#
        let envelope = try APIDecoder.make().decode(Envelope<ProjectList>.self, from: Data(json.utf8))
        let list = try envelope.result()
        #expect(list.projects.first?.name == "chro-orig")
        #expect(envelope.meta.contractRev == "0.1.0+8133f219")
    }

    @Test func failureEnvelopeThrowsTheTypedError() throws {
        let json = #"{"ok":false,"error":{"code":"contract_mismatch","message":"speaks another contract","next":["chro open"]},"meta":{"runtime_id":null,"contract_rev":"0.1.0+8133f219"}}"#
        let envelope = try APIDecoder.make().decode(Envelope<ProjectList>.self, from: Data(json.utf8))
        #expect(throws: APIError.self) { try envelope.result() }
        do { _ = try envelope.result() } catch let error as APIError {
            #expect(error.code == .contractMismatch)
            #expect(error.next == ["chro open"])
        }
    }

    @Test func unknownErrorCodesDecodeInsteadOfFailing() throws {
        let json = #"{"code":"some_future_code","message":"m"}"#
        let body = try APIDecoder.make().decode(APIError.self, from: Data(json.utf8))
        #expect(body.code == .unknown("some_future_code"))
    }
}

struct RFC3339Tests {
    @Test func parsesWithAndWithoutFractionalSecondsAndOffsets() {
        let base = Date(timeIntervalSince1970: 1_763_110_800)
        #expect(RFC3339.parse("2025-11-14T09:00:00Z") == base)
        #expect(RFC3339.parse("2025-11-14T09:00:00.250Z") == base.addingTimeInterval(0.25))
        #expect(RFC3339.parse("2025-11-14T18:00:00+09:00") == base)
        #expect(RFC3339.parse("2025-11-14T09:00:00.123456Z").map { abs($0.timeIntervalSince(base) - 0.123456) < 0.001 } == true)
        #expect(RFC3339.parse("yesterday") == nil)
    }

    @Test func writesAsTheDesktopsToISOString() {
        #expect(RFC3339.string(Date(timeIntervalSince1970: 1_763_110_800.25)) == "2025-11-14T09:00:00.250Z")
    }
}
