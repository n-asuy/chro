import Foundation
import Security
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// Host rows in UserDefaults (no secrets) and device tokens in the Keychain.
struct HostStoreTests {
    let defaults: UserDefaults
    let store: HostStore

    init() {
        let suite = "chro.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        store = HostStore(defaults: defaults)
    }

    private func host(_ id: String, key: UInt8, name: String = "Host 1") -> HostRecord {
        HostRecord(id: id, name: name, endpoint: URL(string: "ws://10.0.0.\(key):6768")!, publicKey: Data(repeating: key, count: 32), lastConnected: Date(timeIntervalSince1970: 1_800_000_000), machineName: nil)
    }

    @Test func emptyByDefault() {
        #expect(store.hosts().isEmpty)
    }

    @Test func savedHostsRoundTripWithoutTokens() throws {
        let a = host("host-1", key: 1)
        try store.upsert(a)
        #expect(store.hosts() == [a])
        let raw = try #require(defaults.data(forKey: HostStore.defaultsKey))
        let text = String(decoding: raw, as: UTF8.self)
        #expect(!text.contains("deviceToken"))
        #expect(text.contains(a.publicKeyB64.replacingOccurrences(of: "/", with: "\\/")) || text.contains(a.publicKeyB64))
    }

    @Test func upsertBySamePublicKeyKeepsIdAndNameAndDropsDuplicates() throws {
        try store.upsert(host("host-1", key: 1, name: "Studio"))
        try store.upsert(host("host-2", key: 2, name: "Host 2"))
        var again = host("host-9", key: 1, name: "Host 3")
        again.endpoint = URL(string: "ws://10.0.0.99:6768")!
        let (saved, replaced) = try store.upsert(again)
        #expect(saved.id == "host-1")
        #expect(saved.name == "Studio")
        #expect(saved.endpoint == URL(string: "ws://10.0.0.99:6768")!)
        #expect(replaced.isEmpty)
        #expect(store.hosts().map(\.id) == ["host-1", "host-2"])
    }

    @Test func duplicateRowsOfOneKeyCollapseAndReportTheDropped() throws {
        // Two rows for one key can only come from older data; the first wins, the rest are reported.
        let rows = [host("host-1", key: 1, name: "A"), host("host-2", key: 1, name: "B"), host("host-3", key: 3)]
        defaults.set(try JSONEncoder().encode(rows), forKey: HostStore.defaultsKey)
        let (saved, replaced) = try store.upsert(host("host-new", key: 1, name: "C"))
        #expect(saved.id == "host-1")
        #expect(saved.name == "A")
        #expect(replaced == ["host-2"])
        #expect(store.hosts().map(\.id) == ["host-1", "host-3"])
    }

    @Test func nextNameIsTheSmallestFreeNumber() throws {
        #expect(store.nextHostName() == "Host 1")
        try store.upsert(host("a", key: 1, name: "Host 1"))
        try store.upsert(host("b", key: 2, name: "Host 3"))
        #expect(store.nextHostName() == "Host 2")
    }

    @Test func removeDeletesTheRow() throws {
        try store.upsert(host("a", key: 1))
        try store.upsert(host("b", key: 2, name: "Host 2"))
        store.remove(id: "a")
        #expect(store.hosts().map(\.id) == ["b"])
    }

    @Test func unreadableRowsAreSkippedNotFatal() throws {
        let good = try JSONEncoder().encode(host("a", key: 1))
        let goodObject = try JSONSerialization.jsonObject(with: good)
        let array: [Any] = [goodObject, ["id": "broken"], 42]
        defaults.set(try JSONSerialization.data(withJSONObject: array), forKey: HostStore.defaultsKey)
        #expect(store.hosts().map(\.id) == ["a"])
    }

    @Test func rowsCarryingATokenAreDropped() throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(host("a", key: 1))) as! [String: Any]
        object["deviceToken"] = "secret"
        defaults.set(try JSONSerialization.data(withJSONObject: [object]), forKey: HostStore.defaultsKey)
        #expect(store.hosts().isEmpty)
    }

    @Test func markConnectedUpdatesTheTimestamp() throws {
        try store.upsert(host("a", key: 1))
        store.markConnected(id: "a", at: Date(timeIntervalSince1970: 1_900_000_000), machineName: "studio")
        #expect(store.hosts()[0].lastConnected == Date(timeIntervalSince1970: 1_900_000_000))
        #expect(store.hosts()[0].machineName == "studio")
    }
}

struct KeychainTokenStoreTests {
    @Test func itemsAreThisDeviceOnlyAndUnlockedOnly() {
        let attributes = KeychainTokenStore(service: "svc").addAttributes(account: "chro.host-token.h1", token: "t")
        #expect(attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        #expect(attributes[kSecClass as String] as? String == kSecClassGenericPassword as String)
        #expect(attributes[kSecAttrService as String] as? String == "svc")
        #expect(attributes[kSecAttrAccount as String] as? String == "chro.host-token.h1")
        #expect(attributes[kSecAttrSynchronizable as String] as? Bool == false)
        #expect(attributes[kSecUseDataProtectionKeychain as String] as? Bool == true)
        #expect(attributes[kSecValueData as String] as? Data == Data("t".utf8))
    }

    @Test func accountNameFollowsTheHostId() {
        #expect(KeychainTokenStore.account(forHost: "host-1700000000000") == "chro.host-token.host-1700000000000")
    }

    @Test func statusMapping() {
        #expect(KeychainTokenStore.error(for: errSecInteractionNotAllowed) == .temporarilyUnavailable)
        #expect(KeychainTokenStore.error(for: errSecMissingEntitlement) == .keychain(errSecMissingEntitlement))
    }

    /// Writes, reads and deletes a real item. On macOS `swift test` the data
    /// protection keychain needs an entitlement the unsigned test runner lacks,
    /// so this is reported as skipped there and runs on the iOS simulator.
    @Test(.enabled(if: KeychainProbe.isAvailable, "the data protection keychain needs a keychain-access-groups entitlement"))
    func roundTripOnARealKeychain() throws {
        let store = KeychainTokenStore(service: "com.chro-ai.ios.tests.\(UUID().uuidString)")
        try store.setToken("first", forHost: "h")
        #expect(try store.token(forHost: "h") == "first")
        try store.setToken("second", forHost: "h")
        #expect(try store.token(forHost: "h") == "second")
        try store.removeToken(forHost: "h")
        #expect(try store.token(forHost: "h") == nil)
        try store.removeToken(forHost: "h")
    }

    @Test func memoryStoreBehavesLikeTheKeychain() throws {
        let store = MemoryTokenStore()
        #expect(try store.token(forHost: "h") == nil)
        try store.setToken("a", forHost: "h")
        #expect(try store.token(forHost: "h") == "a")
        try store.removeToken(forHost: "h")
        #expect(try store.token(forHost: "h") == nil)
    }
}

enum KeychainProbe {
    /// Whether this process may use the data protection keychain.
    static let isAvailable: Bool = {
        let store = KeychainTokenStore(service: "com.chro-ai.ios.tests.probe")
        do {
            try store.setToken("probe", forHost: "probe")
            try store.removeToken(forHost: "probe")
            return true
        } catch {
            return false
        }
    }()
}
