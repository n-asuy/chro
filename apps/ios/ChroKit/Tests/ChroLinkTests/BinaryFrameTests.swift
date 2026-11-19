import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// The plaintext of kind=binary frames (architecture doc §4.1):
/// `0x01 ‖ u32be(header_len) ‖ header JSON ‖ chunk`, 768 KiB chunks.
struct BinaryFrameTests {
    private func header(_ data: Data) -> [String: Any] {
        FakeResponder.decodeBinaryFrame(data)?.header ?? [:]
    }

    @Test func layoutIsVersionLengthHeaderChunk() throws {
        let frame = BinaryFrame.encode(header: ["id": "r", "seq": 0, "final": true], chunk: Data([0xAA, 0xBB]))
        let headerJSON = Data("{\"final\":true,\"id\":\"r\",\"seq\":0}".utf8)
        #expect(frame[0] == 0x01)
        #expect(Array(frame[1..<5]) == [0, 0, 0, UInt8(headerJSON.count)])
        #expect(frame[5..<(5 + headerJSON.count)] == headerJSON)
        #expect(frame.suffix(2) == Data([0xAA, 0xBB]))
        let decoded = try BinaryFrame.decode(frame)
        #expect(decoded.header["id"] as? String == "r")
        #expect(decoded.chunk == Data([0xAA, 0xBB]))
    }

    @Test(arguments: [
        Data(),
        Data([0x01, 0, 0]),
        Data([0x02, 0, 0, 0, 2, 0x7B, 0x7D]),
        Data([0x01, 0, 0, 0, 9, 0x7B, 0x7D]),
        Data([0x01, 0, 0, 0, 2, 0x5B, 0x5D]),
        Data([0x01, 0, 0, 0, 1, 0x78]),
    ])
    func malformedFramesAreRefused(_ payload: Data) {
        #expect(throws: LinkError.self) { try BinaryFrame.decode(payload) }
    }

    @Test func uploadsSplitInto768KiBChunksWithTheEnvelopeOnTheFirst() throws {
        let body = Data((0..<(BinaryFrame.chunkBytes * 2 + 10)).map { UInt8(truncatingIfNeeded: $0) })
        let params = Data("{\"method\":\"POST\",\"path\":\"/rpc/images/upload\",\"upload\":{\"contentType\":\"image/png\",\"field\":\"image\",\"fileName\":\"IMG_0412.png\"}}".utf8)
        let frames = try BinaryFrame.uploadFrames(id: "rpc-7-1", deviceToken: "tok", params: params, body: body)
        #expect(frames.count == 3)
        var collected = Data()
        for (seq, frame) in frames.enumerated() {
            let (header, chunk) = try #require(FakeResponder.decodeBinaryFrame(frame))
            #expect(header["id"] as? String == "rpc-7-1")
            #expect(header["seq"] as? Int == seq)
            #expect(header["final"] as? Bool == (seq == 2))
            if seq == 0 {
                #expect(Set(header.keys) == ["id", "seq", "final", "deviceToken", "method", "params"])
                #expect(header["deviceToken"] as? String == "tok")
                #expect(header["method"] as? String == "request")
                let sent = try #require(header["params"] as? [String: Any])
                #expect(sent["path"] as? String == "/rpc/images/upload")
                #expect((sent["upload"] as? [String: String]) == ["field": "image", "fileName": "IMG_0412.png", "contentType": "image/png"])
            } else {
                #expect(Set(header.keys) == ["id", "seq", "final"])
            }
            #expect(chunk.count <= BinaryFrame.chunkBytes)
            collected.append(chunk)
        }
        #expect(collected == body)
    }

    @Test func anEmptyUploadIsOneFinalFrame() throws {
        let frames = try BinaryFrame.uploadFrames(id: "u", deviceToken: "t", params: Data("{}".utf8), body: Data())
        #expect(frames.count == 1)
        #expect(header(frames[0])["final"] as? Bool == true)
    }

    // MARK: Reply reassembly

    private func first(_ length: Int, ok: Bool = true, final: Bool = false) -> [String: Any] {
        ["id": "r", "seq": 0, "final": final, "ok": ok, "result": ["status": 200, "contentType": "image/png", "contentLength": length]]
    }

    @Test func repliesReassembleInOrder() throws {
        var assembly = try BinaryReplyAssembly(first: first(5), chunk: Data([1, 2]))
        #expect(assembly.isComplete == false)
        try assembly.append(seq: 1, chunk: Data([3, 4]), isFinal: false)
        try assembly.append(seq: 2, chunk: Data([5]), isFinal: true)
        #expect(assembly.isComplete)
        #expect(assembly.reply == BinaryReply(status: 200, contentType: "image/png", data: Data([1, 2, 3, 4, 5])))
    }

    @Test func aGapOrARepeatIsRefused() throws {
        var skipped = try BinaryReplyAssembly(first: first(4), chunk: Data([1]))
        #expect(throws: LinkError.self) { try skipped.append(seq: 2, chunk: Data([2]), isFinal: true) }
        var repeated = try BinaryReplyAssembly(first: first(4), chunk: Data([1]))
        #expect(throws: LinkError.self) { try repeated.append(seq: 0, chunk: Data([2]), isFinal: true) }
    }

    @Test func theDeclaredLengthIsEnforced() throws {
        var short = try BinaryReplyAssembly(first: first(3), chunk: Data([1]))
        #expect(throws: LinkError.self) { try short.append(seq: 1, chunk: Data([2]), isFinal: true) }
        var long = try BinaryReplyAssembly(first: first(2), chunk: Data([1]))
        #expect(throws: LinkError.self) { try long.append(seq: 1, chunk: Data([2, 3]), isFinal: false) }
        #expect(throws: LinkError.self) { try BinaryReplyAssembly(first: first(BinaryReplyAssembly.maxBytes + 1), chunk: Data()) }
    }

    @Test func theFirstHeaderMustCarryASuccessfulResult() {
        #expect(throws: LinkError.self) { try BinaryReplyAssembly(first: ["id": "r", "seq": 0, "final": true], chunk: Data()) }
        #expect(throws: LinkError.self) { try BinaryReplyAssembly(first: first(0, ok: false, final: true), chunk: Data()) }
    }
}
