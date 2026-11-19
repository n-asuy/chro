import ChroLink
import Foundation

/// Which host was active last, kept in UserDefaults (`chro.activeHostId`).
final class ActiveHostSetting: @unchecked Sendable {
    static let key = "chro.activeHostId"
    private let defaults: UserDefaults

    init(_ defaults: UserDefaults) { self.defaults = defaults }

    var hostID: String? {
        get { defaults.string(forKey: Self.key) }
        set { defaults.set(newValue, forKey: Self.key) }
    }
}

/// The link to the desktop the app is talking to. Holds one `ChroLink` for the
/// active host, built from its stored row and Keychain token, and replaces it
/// when another host is activated.
actor LiveHostLinks {
    typealias MakeLink = @Sendable (ChroLink.Host, String) -> ChroLink

    private let hosts: HostStore
    private let tokens: any DeviceTokenStore
    private let setting: ActiveHostSetting
    private let makeLink: MakeLink
    private let now: @Sendable () -> Date
    private let onState: @Sendable (String, ChroLink.State) -> Void
    private var active: (hostID: String, link: ChroLink)?
    private var connectionWatcher: Task<Void, Never>?
    private var observers: [UUID: AsyncStream<ChroLink?>.Continuation] = [:]

    init(hosts: HostStore, tokens: any DeviceTokenStore, setting: ActiveHostSetting, now: @escaping @Sendable () -> Date,
         makeLink: @escaping MakeLink, onState: @escaping @Sendable (String, ChroLink.State) -> Void) {
        self.hosts = hosts
        self.onState = onState
        self.tokens = tokens
        self.setting = setting
        self.now = now
        self.makeLink = makeLink
    }

    /// The host activated last time, if it is still paired.
    static func storedActiveHostID(_ setting: ActiveHostSetting, hosts: HostStore) -> String? {
        setting.hostID.flatMap { id in hosts.host(id: id) != nil ? id : nil }
    }

    /// Connects to `hostID` (closing the previous link), or disconnects for nil.
    func activate(_ hostID: String?) async {
        guard hostID != active?.hostID else { return }
        if let previous = active {
            connectionWatcher?.cancel()
            await previous.link.stop()
        }
        active = nil
        setting.hostID = hostID
        if let hostID, let row = hosts.host(id: hostID), let host = row.linkHost, let token = try? tokens.token(forHost: hostID) {
            let link = makeLink(host, token)
            active = (hostID, link)
            watchConnections(of: link, hostID: hostID)
            await link.start()
        }
        for observer in observers.values { observer.yield(active?.link) }
    }

    /// A new link to the active host (Retry after `authFailed`), announced like a switch.
    func restart() async {
        guard let hostID = active?.hostID else { return }
        await activate(nil)
        await activate(hostID)
    }

    /// The active link; throws when no paired desktop is active.
    func link() throws -> ChroLink {
        guard let link = active?.link else { throw ServiceError.unavailable(LinkError.stopped.errorDescription ?? "") }
        return link
    }

    /// The active link now, then each replacement (nil when none is active).
    func changes() -> AsyncStream<ChroLink?> {
        let (stream, continuation) = AsyncStream<ChroLink?>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let id = UUID()
        continuation.yield(active?.link)
        observers[id] = continuation
        continuation.onTermination = { _ in Task { await self.removeObserver(id) } }
        return stream
    }

    private func removeObserver(_ id: UUID) {
        observers.removeValue(forKey: id)
    }

    /// Reports each state of the link and records each successful connection on the host's row.
    private func watchConnections(of link: ChroLink, hostID: String) {
        let hosts = self.hosts
        let now = self.now
        let onState = self.onState
        connectionWatcher = Task {
            for await state in await link.states() {
                if state == .connected { hosts.markConnected(id: hostID, at: now(), machineName: nil) }
                onState(hostID, state)
            }
        }
    }
}
