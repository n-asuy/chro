import Foundation

/// The plaintext of a kind=binary frame (architecture doc §4.1):
///
///     version(1) = 0x01 ‖ u32be(header_len) ‖ header (UTF-8 JSON object) ‖ chunk
///
/// One payload (an upload or a reply body) spans several frames that share an
/// `id`; `seq` counts from 0 and the last frame has `final: true`. Only the
/// first frame's header carries the envelope, later ones only `{id, seq, final}`.
enum BinaryFrame {
    static let version: UInt8 = 0x01
    /// Largest chunk per frame, so a sealed frame stays under the host's 1 MiB message limit.
    static let chunkBytes = 768 * 1024
    private static let prefixBytes = 1 + 4

    static func encode(header: [String: Any], chunk: Data) -> Data {
        let json = try! JSONSerialization.data(withJSONObject: header, options: [.sortedKeys, .withoutEscapingSlashes])
        var out = Data(capacity: prefixBytes + json.count + chunk.count)
        out.append(version)
        withUnsafeBytes(of: UInt32(json.count).bigEndian) { out.append(contentsOf: $0) }
        out.append(json)
        out.append(chunk)
        return out
    }

    static func decode(_ payload: Data) throws -> (header: [String: Any], chunk: Data) {
        let bytes = [UInt8](payload)
        guard bytes.count >= prefixBytes else { throw LinkError.malformedResponse("binary frame shorter than its prefix") }
        guard bytes[0] == version else { throw LinkError.malformedResponse("binary frame version \(bytes[0])") }
        let length = bytes[1..<prefixBytes].reduce(0) { $0 << 8 | Int($1) }
        guard prefixBytes + length <= bytes.count else { throw LinkError.malformedResponse("binary frame header overruns the frame") }
        guard let header = (try? JSONSerialization.jsonObject(with: Data(bytes[prefixBytes..<(prefixBytes + length)]))) as? [String: Any] else {
            throw LinkError.malformedResponse("binary frame header is not a JSON object")
        }
        return (header, Data(bytes[(prefixBytes + length)...]))
    }

    /// The frames of one upload: the first header is the `request` envelope
    /// `{id, seq:0, final, deviceToken, method:"request", params}`.
    static func uploadFrames(id: String, deviceToken: String, params: Data, body: Data) throws -> [Data] {
        guard let paramsObject = try? JSONSerialization.jsonObject(with: params) else {
            throw LinkError.malformedResponse("upload params are not JSON")
        }
        let chunks = stride(from: 0, to: max(body.count, 1), by: chunkBytes).map {
            body.subdata(in: body.startIndex.advanced(by: min($0, body.count))..<body.startIndex.advanced(by: min($0 + chunkBytes, body.count)))
        }
        return chunks.enumerated().map { seq, chunk in
            var header: [String: Any] = ["id": id, "seq": seq, "final": seq == chunks.count - 1]
            if seq == 0 {
                header["deviceToken"] = deviceToken
                header["method"] = "request"
                header["params"] = paramsObject
            }
            return encode(header: header, chunk: chunk)
        }
    }
}

/// A `request` answered in binary frames.
struct BinaryReply: Equatable, Sendable {
    let status: Int
    let contentType: String
    let data: Data
}

/// Collects one binary reply. The first header is
/// `{id, seq:0, final, ok:true, result:{status, contentType, contentLength}}`;
/// chunks must follow in order and add up to `contentLength`, at most 8 MiB.
struct BinaryReplyAssembly {
    /// The host's cap on a binary reply (dispatch.rs `MAX_BINARY_REPLY_BYTES`).
    static let maxBytes = 8 * 1024 * 1024

    private let status: Int
    private let contentType: String
    private let contentLength: Int
    private var body = Data()
    private var nextSeq = 1
    private(set) var isComplete = false

    init(first header: [String: Any], chunk: Data) throws {
        guard header["ok"] as? Bool == true, let result = header["result"] as? [String: Any],
              let status = result["status"] as? Int, let contentType = result["contentType"] as? String,
              let length = result["contentLength"] as? Int, length >= 0
        else { throw LinkError.malformedResponse("binary reply header") }
        guard length <= Self.maxBytes else { throw LinkError.malformedResponse("binary reply of \(length) bytes") }
        self.status = status
        self.contentType = contentType
        contentLength = length
        try add(chunk, isFinal: header["final"] as? Bool == true)
    }

    mutating func append(seq: Int, chunk: Data, isFinal: Bool) throws {
        guard !isComplete, seq == nextSeq else { throw LinkError.malformedResponse("binary reply chunk \(seq), expected \(nextSeq)") }
        nextSeq += 1
        try add(chunk, isFinal: isFinal)
    }

    private mutating func add(_ chunk: Data, isFinal: Bool) throws {
        guard body.count + chunk.count <= contentLength else { throw LinkError.malformedResponse("binary reply longer than its contentLength") }
        body.append(chunk)
        if isFinal {
            guard body.count == contentLength else { throw LinkError.malformedResponse("binary reply shorter than its contentLength") }
            isComplete = true
        }
    }

    var reply: BinaryReply? {
        isComplete ? BinaryReply(status: status, contentType: contentType, data: body) : nil
    }
}
