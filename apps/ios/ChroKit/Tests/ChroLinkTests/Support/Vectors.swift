import Foundation

/// The shared E2EE v2 test vectors of crates/mobile-link, read from the repository
/// so the Rust and Swift sides check the very same file.
struct Vectors: Decodable {
    struct Labels: Decodable {
        let `protocol`: String
        let transcriptDomain: String
        let salt: String
        let session: String
    }

    struct Context: Decodable {
        let `protocol`: String
        let transport: String
        let relayHostId: String?
    }

    struct Schedule: Decodable {
        let context: Context
        let clientPublicKeyHex: String
        let clientNonceHex: String
        let desktopPublicKeyHex: String
        let desktopNonceHex: String
        let sharedHex: String
        let transcriptLength: Int
        let transcriptHex: String
        let transcriptHashHex: String
        let mobileToDesktopKeyHex: String
        let desktopToMobileKeyHex: String
        let sessionIdHex: String
    }

    struct Frame: Decodable {
        let direction: UInt8
        let kind: UInt8
        let counter: UInt64
        let payloadUtf8: String?
        let payloadHex: String?
        let frameHex: String
        let frameB64: String?

        var payload: Data { payloadUtf8.map { Data($0.utf8) } ?? Data(hex: payloadHex!) }
    }

    struct EndToEnd: Decodable {
        let context: Context
        let clientSecretKeyHex: String
        let clientPublicKeyHex: String
        let desktopSecretKeyHex: String
        let desktopPublicKeyHex: String
        let clientNonceHex: String
        let desktopNonceHex: String
        let sharedHex: String
        let transcriptHashHex: String
        let mobileToDesktopKeyHex: String
        let desktopToMobileKeyHex: String
        let sessionIdHex: String
        let frames: [Frame]
    }

    struct Nonce: Decodable {
        let sessionIdHex: String
        let direction: UInt8
        let kind: UInt8
        let counter: UInt64
        let nonceHex: String
    }

    let labels: Labels
    let keySchedule: [Schedule]
    let endToEnd: EndToEnd
    let nonce: Nonce
    let frameOverheadBytes: Int

    static func load() throws -> Vectors {
        // Drop the file name and Support/ChroLinkTests/Tests/ChroKit/ios/apps to reach the repository root.
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { url.deleteLastPathComponent() }
        url.append(path: "crates/mobile-link/testdata/e2ee-v2-vectors.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }
}

extension Data {
    init(hex: String) {
        precondition(hex.count % 2 == 0, "odd hex length")
        var bytes = [UInt8]()
        bytes.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        self.init(bytes)
    }
}
