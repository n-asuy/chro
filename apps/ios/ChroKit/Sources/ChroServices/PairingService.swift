import Foundation

/// A desktop this phone has paired with. Secrets (the device token) live in
/// the Keychain of the transport and never appear here.
public struct PairedHost: Identifiable, Equatable, Sendable, Hashable {
    public var id: String
    /// "Host N" until the user or the desktop's machine name gives a better one.
    public var name: String
    public var endpoint: String
    public var lastConnected: Date?

    public init(id: String, name: String, endpoint: String, lastConnected: Date? = nil) {
        self.id = id
        self.name = name
        self.endpoint = endpoint
        self.lastConnected = lastConnected
    }
}

/// The link to the active host as the screens show it (pairing protocol §4.3).
public enum HostConnection: Equatable, Sendable {
    case connecting
    case connected
    /// Refused three times in a row: revoked on the desktop, or its pairing reset.
    case authFailed
    /// The desktop's chro speaks another `apiGeneration`.
    case incompatible
}

public struct PairingState: Equatable, Sendable {
    public var hosts: [PairedHost]
    /// The host the app is talking to; nil shows the host list or pairing.
    public var activeHostID: String?
    /// The active host's link.
    public var connection: HostConnection

    public init(hosts: [PairedHost], activeHostID: String?, connection: HostConnection = .connecting) {
        self.hosts = hosts
        self.activeHostID = activeHostID
        self.connection = connection
    }

    public var activeHost: PairedHost? { hosts.first { $0.id == activeHostID } }
}

/// How the pairing code reached the phone. The camera accepts only a
/// `chro://pair` URL; a pasted value may also be the bare code.
public enum PairingSource: Sendable, Equatable { case camera, paste, link }

public enum PairingProgress: Equatable, Sendable {
    /// One line of the pairing log ("Opening connection…").
    case step(String)
    case paired(PairedHost)
}

/// The failures the pairing screen tells apart (pairing protocol §2.1).
public enum PairingError: Error, Equatable, Sendable {
    /// The QR that installs the app, not the pairing code.
    case downloadCode
    case invalidQRCode
    case invalidPastedCode
    case timedOut(seconds: Int)
    /// Expired, already used or replaced on the desktop.
    case rejected
    case failed(String)

    public var message: String {
        switch self {
        case .downloadCode: return "That's the download code. Scan the pairing code in Settings → Mobile on your desktop."
        case .invalidQRCode: return "Not a valid Chro QR code"
        case .invalidPastedCode: return "Not a valid pairing code — copy it from your computer and paste again"
        case .timedOut(let seconds): return "Couldn't connect within \(seconds)s — see log below for where it stalled"
        case .rejected: return "This pairing code expired, was already used, or was replaced. Show a new code on your desktop and scan again."
        case .failed(let error): return "Pairing failed: \(error)"
        }
    }
}

/// Pairing with desktops and choosing which one the app talks to.
public protocol PairingService: Sendable {
    func hosts() -> AsyncStream<PairingState>
    /// Decode the offer, connect, authenticate and store the host. Yields log
    /// steps, then `.paired`; throws a `PairingError`.
    func pair(code: String, source: PairingSource) -> AsyncThrowingStream<PairingProgress, Error>
    func activate(hostID: String?) async
    /// Retry: a fresh link to the active host, its refusals counted from zero.
    func reconnect() async
    /// Forget the host on this phone (the desktop keeps its device row until revoked there).
    func remove(hostID: String) async
}
