import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// `chro://pair?code=` decoding, tolerant in the ways spec §2.2 lists and strict everywhere else.
struct PairingOfferTests {
    static let publicKey = Data((0..<32).map { UInt8($0) })
    static let publicKeyB64 = publicKey.base64EncodedString()
    static let token = String(repeating: "ab", count: 24)

    static func json(_ fields: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    }

    static var validFields: [String: Any] {
        ["v": 2, "endpoint": "ws://192.168.1.23:6768", "deviceToken": token, "publicKeyB64": publicKeyB64, "pairedDeviceId": "0b7e7f0e-2b9d-4c1e-9a7a-6f1d2a3b4c5d", "scope": "mobile"]
    }

    /// base64url without padding, as the desktop writes it.
    static func code(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static var validCode: String { code(json(validFields)) }

    @Test func decodesTheDesktopsUrl() throws {
        let offer = try PairingOffer.decode("chro://pair?code=\(Self.validCode)", source: .camera)
        #expect(offer.endpoint == URL(string: "ws://192.168.1.23:6768")!)
        #expect(offer.deviceToken == Self.token)
        #expect(offer.publicKey == Self.publicKey)
        #expect(offer.publicKeyB64 == Self.publicKeyB64)
    }

    @Test func acceptsStandardBase64WithPadding() throws {
        // Pick a body whose base64 needs padding and contains + or /.
        var fields = Self.validFields
        fields["pairedDeviceId"] = "??>>??"
        let standard = Self.json(fields).base64EncodedString()
        #expect(standard.hasSuffix("=") || standard.contains("+") || standard.contains("/"))
        let offer = try PairingOffer.decode("chro://pair?code=\(standard.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)", source: .camera)
        #expect(offer.deviceToken == Self.token)
        let pasted = try PairingOffer.decode(standard, source: .paste)
        #expect(pasted == offer)
    }

    @Test func bareCodeOnlyFromPaste() throws {
        #expect(throws: PairingCodeError.notAPairingCode(.camera)) { try PairingOffer.decode(Self.validCode, source: .camera) }
        #expect(try PairingOffer.decode(Self.validCode, source: .paste).deviceToken == Self.token)
    }

    @Test func schemeAndHostAreCaseInsensitiveAndWhitespaceIsTrimmed() throws {
        let offer = try PairingOffer.decode("  \nCHRO://Pair/?code=\(Self.validCode)\t ", source: .camera)
        #expect(offer.deviceToken == Self.token)
    }

    @Test func fragmentIsUsedWhenThereIsNoCodeQuery() throws {
        let offer = try PairingOffer.decode("chro://pair#\(Self.validCode)", source: .camera)
        #expect(offer.deviceToken == Self.token)
    }

    @Test func otherHostsPathsAndSchemesAreRejected() {
        for text in [
            "chro://pairing?code=\(Self.validCode)",
            "chro://pair/extra?code=\(Self.validCode)",
            "other://pair?code=\(Self.validCode)",
            "https://example.com/pair?code=\(Self.validCode)",
            "chro://pair",
            "chro://pair?code=",
        ] {
            #expect(throws: PairingCodeError.self, "\(text)") { try PairingOffer.decode(text, source: .paste) }
        }
    }

    @Test func codeSyntaxIsChecked() {
        let valid = Self.validCode
        for code in [valid + "===", valid + "!", "a", String(repeating: "A", count: PairingOffer.maxCodeLength + 1)] {
            #expect(throws: PairingCodeError.self, "\(code.prefix(20))") { try PairingOffer.decode(code, source: .paste) }
        }
    }

    @Test func lengthOneMod4IsRejected() {
        // 5 symbols: one past a full quantum cannot be base64.
        #expect(throws: PairingCodeError.self) { try PairingOffer.decode("AAAAA", source: .paste) }
    }

    @Test func offerFieldsAreValidated() {
        var cases: [[String: Any]] = []
        var f = Self.validFields; f["v"] = 1; cases.append(f)
        f = Self.validFields; f["v"] = "2"; cases.append(f)
        f = Self.validFields; f.removeValue(forKey: "endpoint"); cases.append(f)
        f = Self.validFields; f["endpoint"] = ""; cases.append(f)
        f = Self.validFields; f["endpoint"] = "http://192.168.1.23:6768"; cases.append(f)
        f = Self.validFields; f["endpoint"] = "ws://"; cases.append(f)
        f = Self.validFields; f["deviceToken"] = ""; cases.append(f)
        f = Self.validFields; f.removeValue(forKey: "deviceToken"); cases.append(f)
        f = Self.validFields; f["publicKeyB64"] = Data(count: 31).base64EncodedString(); cases.append(f)
        f = Self.validFields; f["publicKeyB64"] = String(Self.publicKeyB64.dropLast()); cases.append(f)
        f = Self.validFields; f["scope"] = "admin"; cases.append(f)
        f = Self.validFields; f["pairedDeviceId"] = ""; cases.append(f)
        f = Self.validFields; f["scope"] = "runtime"; f["relay"] = ["v": 1]; cases.append(f)
        for fields in cases {
            #expect(throws: PairingCodeError.self, "\(fields)") { try PairingOffer.decode(Self.code(Self.json(fields)), source: .paste) }
        }
    }

    @Test func notJsonIsRejected() {
        #expect(throws: PairingCodeError.self) { try PairingOffer.decode(Self.code(Data("not json".utf8)), source: .paste) }
        #expect(throws: PairingCodeError.self) { try PairingOffer.decode(Self.code(Data("[1]".utf8)), source: .paste) }
    }

    @Test func unknownFieldsAndOptionalOnesAreIgnored() throws {
        var fields = Self.validFields
        fields["hostDescriptor"] = ["junk": true]
        fields["future"] = 42
        fields.removeValue(forKey: "pairedDeviceId")
        fields.removeValue(forKey: "scope")
        #expect(try PairingOffer.decode(Self.code(Self.json(fields)), source: .paste).deviceToken == Self.token)
    }

    @Test func endpointGetsTheDefaultPort() throws {
        var fields = Self.validFields
        fields["endpoint"] = "ws://192.168.1.23"
        #expect(try PairingOffer.decode(Self.code(Self.json(fields)), source: .paste).endpoint == URL(string: "ws://192.168.1.23:6768")!)
        fields["endpoint"] = "wss://desk.example.ts.net"
        #expect(try PairingOffer.decode(Self.code(Self.json(fields)), source: .paste).endpoint == URL(string: "wss://desk.example.ts.net:443")!)
        fields["endpoint"] = "ws://[fd7a:115c:a1e0::1]:7000"
        #expect(try PairingOffer.decode(Self.code(Self.json(fields)), source: .paste).endpoint == URL(string: "ws://[fd7a:115c:a1e0::1]:7000")!)
    }

    @Test func aMagicDNSEndpointKeepsItsHostnameAndCustomPort() throws {
        // The desktop's custom address: a tailnet hostname on a non-default port.
        var fields = Self.validFields
        fields["endpoint"] = "ws://mac.tail1234.ts.net:7443"
        let offer = try PairingOffer.decode("chro://pair?code=\(Self.code(Self.json(fields)))", source: .camera)
        #expect(offer.endpoint == URL(string: "ws://mac.tail1234.ts.net:7443")!)
        #expect(offer.endpoint.host == "mac.tail1234.ts.net")
        #expect(offer.endpoint.port == 7443)
        #expect(try PairingOffer.decode(offer.pairingURL.absoluteString, source: .camera) == offer)
    }

    @Test func encodeIsTheInverseOfDecode() throws {
        let offer = try PairingOffer.decode("chro://pair?code=\(Self.validCode)", source: .camera)
        #expect(try PairingOffer.decode(offer.pairingURL.absoluteString, source: .camera) == offer)
    }
}
