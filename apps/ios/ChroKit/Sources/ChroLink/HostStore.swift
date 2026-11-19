import Foundation

/// A paired desktop as the phone remembers it. No secrets: the device token is
/// in the `DeviceTokenStore` under the same id.
public struct HostRecord: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public var name: String
    public var endpoint: URL
    /// The pinned X25519 key, standard base64 with padding.
    public var publicKeyB64: String
    public var lastConnected: Date?
    /// `machineName` from the last `status.get`.
    public var machineName: String?

    public init(id: String, name: String, endpoint: URL, publicKey: Data, lastConnected: Date?, machineName: String?) {
        self.id = id
        self.name = name
        self.endpoint = endpoint
        self.publicKeyB64 = publicKey.base64EncodedString()
        self.lastConnected = lastConnected
        self.machineName = machineName
    }

    public var publicKey: Data? { try? CanonicalBase64.decode(publicKeyB64, count: NaCl.keyBytes) }

    /// Where and to whom `ChroLink` connects.
    public var linkHost: ChroLink.Host? {
        publicKey.map { ChroLink.Host(endpoint: endpoint, publicKey: $0) }
    }
}

/// The paired-host list in UserDefaults, matched by public key (spec §2.4, §2.5).
public final class HostStore: @unchecked Sendable {
    public static let defaultsKey = "chro.hosts"
    private let defaults: UserDefaults
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Readable rows in stored order. Unreadable rows are skipped, and rows that
    /// carry a token are dropped: tokens belong to the Keychain only.
    public func hosts() -> [HostRecord] {
        lock.withLock { load() }
    }

    public func host(id: String) -> HostRecord? {
        hosts().first { $0.id == id }
    }

    public func host(publicKeyB64: String) -> HostRecord? {
        hosts().first { $0.publicKeyB64 == publicKeyB64 }
    }

    /// "Host N" with the smallest N no row uses.
    public func nextHostName() -> String {
        let used = Set(hosts().map(\.name))
        var number = 1
        while used.contains("Host \(number)") { number += 1 }
        return "Host \(number)"
    }

    /// Saves a pairing. A row with the same public key is overwritten in place
    /// (its id and name are kept); further rows with that key are removed and
    /// their ids returned so their tokens can be deleted.
    @discardableResult
    public func upsert(_ host: HostRecord) throws -> (saved: HostRecord, replaced: [String]) {
        try lock.withLock {
            var rows = load()
            let matches = rows.indices.filter { rows[$0].publicKeyB64 == host.publicKeyB64 }
            var saved = host
            var replaced: [String] = []
            if let first = matches.first {
                saved = rows[first]
                saved.endpoint = host.endpoint
                saved.lastConnected = host.lastConnected
                if let machineName = host.machineName { saved.machineName = machineName }
                rows[first] = saved
                replaced = matches.dropFirst().map { rows[$0].id }
                rows.removeAll { replaced.contains($0.id) }
            } else {
                rows.append(saved)
            }
            try store(rows)
            return (saved, replaced)
        }
    }

    public func markConnected(id: String, at date: Date, machineName: String?) {
        lock.withLock {
            var rows = load()
            guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
            rows[index].lastConnected = date
            if let machineName { rows[index].machineName = machineName }
            try? store(rows)
        }
    }

    public func remove(id: String) {
        lock.withLock {
            var rows = load()
            rows.removeAll { $0.id == id }
            try? store(rows)
        }
    }

    private func load() -> [HostRecord] {
        guard let data = defaults.data(forKey: Self.defaultsKey),
              let array = (try? JSONSerialization.jsonObject(with: data)) as? [Any]
        else { return [] }
        let decoder = JSONDecoder()
        return array.compactMap { element in
            guard let object = element as? [String: Any], object["deviceToken"] == nil,
                  let row = try? JSONSerialization.data(withJSONObject: object),
                  let host = try? decoder.decode(HostRecord.self, from: row),
                  host.publicKey != nil
            else { return nil }
            return host
        }
    }

    private func store(_ rows: [HostRecord]) throws {
        defaults.set(try JSONEncoder().encode(rows), forKey: Self.defaultsKey)
    }
}
