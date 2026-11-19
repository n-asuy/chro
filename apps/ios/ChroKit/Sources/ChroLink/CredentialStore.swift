import Foundation
import Security

public enum CredentialError: Error, Equatable, Sendable {
    /// The device is locked; tokens are readable again after unlock.
    case temporarilyUnavailable
    case keychain(OSStatus)
}

/// Where device tokens live. Tokens never go to UserDefaults or logs.
public protocol DeviceTokenStore: Sendable {
    func token(forHost hostId: String) throws -> String?
    func setToken(_ token: String, forHost hostId: String) throws
    func removeToken(forHost hostId: String) throws
}

/// Device tokens in the Keychain, readable only while unlocked and never
/// synced or restored to another device (`WhenUnlockedThisDeviceOnly`).
public struct KeychainTokenStore: DeviceTokenStore {
    public static let defaultService = "com.chro-ai.ios.device-token"
    public let service: String

    public init(service: String = KeychainTokenStore.defaultService) {
        self.service = service
    }

    static func account(forHost hostId: String) -> String { "chro.host-token.\(hostId)" }

    func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    func addAttributes(account: String, token: String) -> [String: Any] {
        var attributes = baseQuery(account: account)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        attributes[kSecAttrSynchronizable as String] = false
        attributes[kSecValueData as String] = Data(token.utf8)
        return attributes
    }

    static func error(for status: OSStatus) -> CredentialError {
        status == errSecInteractionNotAllowed ? .temporarilyUnavailable : .keychain(status)
    }

    public func token(forHost hostId: String) throws -> String? {
        var query = baseQuery(account: Self.account(forHost: hostId))
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else { throw CredentialError.keychain(errSecDecode) }
            return String(decoding: data, as: UTF8.self)
        case errSecItemNotFound:
            return nil
        default:
            throw Self.error(for: status)
        }
    }

    public func setToken(_ token: String, forHost hostId: String) throws {
        let account = Self.account(forHost: hostId)
        // Replace rather than update so the accessibility class is always the current one.
        let deleted = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw Self.error(for: deleted) }
        let status = SecItemAdd(addAttributes(account: account, token: token) as CFDictionary, nil)
        guard status == errSecSuccess else { throw Self.error(for: status) }
    }

    public func removeToken(forHost hostId: String) throws {
        let status = SecItemDelete(baseQuery(account: Self.account(forHost: hostId)) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.error(for: status) }
    }
}

/// In-memory tokens for previews and tests.
public final class MemoryTokenStore: DeviceTokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String: String] = [:]

    public init() {}

    public func token(forHost hostId: String) throws -> String? {
        lock.withLock { tokens[hostId] }
    }

    public func setToken(_ token: String, forHost hostId: String) throws {
        lock.withLock { tokens[hostId] = token }
    }

    public func removeToken(forHost hostId: String) throws {
        _ = lock.withLock { tokens.removeValue(forKey: hostId) }
    }

    /// Every account holding a token, sorted.
    public var accounts: [String] { lock.withLock { tokens.keys.sorted() } }
}
