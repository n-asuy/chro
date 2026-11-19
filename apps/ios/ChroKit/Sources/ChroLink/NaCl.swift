import Clibsodium
import Foundation

/// The libsodium calls E2EE v2 needs, with Data in and out.
enum NaCl {
    static let keyBytes = 32
    static let secretboxNonceBytes = 24
    static let secretboxMacBytes = 16

    private static let ready: Bool = sodium_init() >= 0

    private static func ensureReady() throws {
        guard ready else { throw NaClError.unavailable }
    }

    /// X25519 public key of a secret key.
    static func publicKey(secretKey: Data) throws -> Data {
        try ensureReady()
        guard secretKey.count == keyBytes else { throw NaClError.badLength }
        var out = Data(count: keyBytes)
        let status = out.withUnsafeMutableBytes { o in
            secretKey.withUnsafeBytes { s in
                crypto_scalarmult_base(o.bindMemory(to: UInt8.self).baseAddress!, s.bindMemory(to: UInt8.self).baseAddress!)
            }
        }
        guard status == 0 else { throw NaClError.failed }
        return out
    }

    /// A fresh X25519 key pair (secret, public).
    static func boxKeyPair() throws -> (secretKey: Data, publicKey: Data) {
        let secretKey = try randomBytes(keyBytes)
        return (secretKey, try publicKey(secretKey: secretKey))
    }

    /// `crypto_box_beforenm`: HSalsa20 over the X25519 point, not the raw point.
    static func boxBeforeNM(publicKey: Data, secretKey: Data) throws -> Data {
        try ensureReady()
        guard publicKey.count == keyBytes, secretKey.count == keyBytes else { throw NaClError.badLength }
        var out = Data(count: Int(crypto_box_beforenmbytes()))
        let status = out.withUnsafeMutableBytes { o in
            publicKey.withUnsafeBytes { p in
                secretKey.withUnsafeBytes { s in
                    crypto_box_beforenm(o.bindMemory(to: UInt8.self).baseAddress!, p.bindMemory(to: UInt8.self).baseAddress!, s.bindMemory(to: UInt8.self).baseAddress!)
                }
            }
        }
        // libsodium refuses low-order points (an all-zero shared secret).
        guard status == 0 else { throw NaClError.failed }
        return out
    }

    /// `crypto_secretbox_easy`: MAC(16) followed by the ciphertext.
    static func secretboxSeal(_ message: Data, nonce: Data, key: Data) throws -> Data {
        try ensureReady()
        guard nonce.count == secretboxNonceBytes, key.count == keyBytes else { throw NaClError.badLength }
        var out = Data(count: message.count + secretboxMacBytes)
        let status = out.withUnsafeMutableBytes { o in
            message.withUnsafeBytes { m in
                nonce.withUnsafeBytes { n in
                    key.withUnsafeBytes { k in
                        crypto_secretbox_easy(
                            o.bindMemory(to: UInt8.self).baseAddress!,
                            m.bindMemory(to: UInt8.self).baseAddress,
                            UInt64(message.count),
                            n.bindMemory(to: UInt8.self).baseAddress!,
                            k.bindMemory(to: UInt8.self).baseAddress!
                        )
                    }
                }
            }
        }
        guard status == 0 else { throw NaClError.failed }
        return out
    }

    /// `crypto_secretbox_open_easy`; nil when the MAC does not verify.
    static func secretboxOpen(_ boxed: Data, nonce: Data, key: Data) throws -> Data? {
        try ensureReady()
        guard nonce.count == secretboxNonceBytes, key.count == keyBytes else { throw NaClError.badLength }
        guard boxed.count >= secretboxMacBytes else { return nil }
        var out = Data(count: boxed.count - secretboxMacBytes)
        let status = out.withUnsafeMutableBytes { o in
            boxed.withUnsafeBytes { c in
                nonce.withUnsafeBytes { n in
                    key.withUnsafeBytes { k in
                        crypto_secretbox_open_easy(
                            o.bindMemory(to: UInt8.self).baseAddress,
                            c.bindMemory(to: UInt8.self).baseAddress!,
                            UInt64(boxed.count),
                            n.bindMemory(to: UInt8.self).baseAddress!,
                            k.bindMemory(to: UInt8.self).baseAddress!
                        )
                    }
                }
            }
        }
        return status == 0 ? out : nil
    }

    static func randomBytes(_ count: Int) throws -> Data {
        try ensureReady()
        var out = Data(count: count)
        out.withUnsafeMutableBytes { o in
            if let base = o.baseAddress { randombytes_buf(base, count) }
        }
        return out
    }

    /// Constant-time equality; unequal lengths are unequal without comparing contents.
    static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        guard !a.isEmpty else { return true }
        return a.withUnsafeBytes { x in
            b.withUnsafeBytes { y in
                sodium_memcmp(x.baseAddress!, y.baseAddress!, a.count) == 0
            }
        }
    }
}

enum NaClError: Error, Equatable {
    case unavailable
    case badLength
    case failed
}

/// Strict standard base64 (with padding) that re-encodes to the same text, so a
/// value has exactly one accepted spelling.
enum CanonicalBase64 {
    static func decode(_ text: String) throws -> Data {
        guard let data = Data(base64Encoded: text), data.base64EncodedString() == text else {
            throw CanonicalBase64Error.notCanonical
        }
        return data
    }

    /// Decodes a canonical base64 value of exactly `count` bytes.
    static func decode(_ text: String, count: Int) throws -> Data {
        let data = try decode(text)
        guard data.count == count else { throw CanonicalBase64Error.notCanonical }
        return data
    }
}

enum CanonicalBase64Error: Error, Equatable { case notCanonical }

extension Data {
    /// Lowercase hex.
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
