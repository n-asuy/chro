import ChroLink
import Foundation

extension LiveWorkspace: PairingService {
    public func hosts() -> AsyncStream<PairingState> { pairingState.stream() }

    /// Decodes the `chro://pair?code=` offer, pairs over E2EE v2 (ticket,
    /// capabilities, `status.get`, ticket exchange), stores the token in the
    /// Keychain and the host row, and makes the host active.
    public func pair(code: String, source: PairingSource) -> AsyncThrowingStream<PairingProgress, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let offer = try Self.offer(code, source: source)
                    let record = try await pairingCoordinator.pair(offer: offer) { phase in
                        for line in Self.logLines(phase) { continuation.yield(.step(line)) }
                    }
                    await activate(hostID: record.id)
                    continuation.yield(.paired(PairedHost(record)))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: Self.pairingError(error, source: source))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// The pairing log's lines for one milestone.
    static func logLines(_ phase: PairingPhase) -> [String] {
        switch phase {
        case .connecting(let endpoint): ["Opening connection to \(endpoint.absoluteString)"]
        case .retrying(let reason): ["Couldn't connect: \(reason). Retrying…"]
        case .authenticated: ["Encrypted channel ready", "Device authenticated"]
        }
    }

    public func activate(hostID: String?) async {
        let id = hostID.flatMap { hostStore.host(id: $0)?.id }
        pairingState.update { state in
            // Activating the host already active keeps its link, and so its state.
            let connection = id != nil && id == state.activeHostID ? state.connection : .connecting
            state = PairingState(hosts: hostStore.hosts().map(PairedHost.init), activeHostID: id, connection: connection)
        }
        await links.activate(id)
    }

    public func reconnect() async {
        pairingState.update { $0.connection = .connecting }
        await links.restart()
    }

    /// Forgets the host on this phone: its row and its Keychain token.
    public func remove(hostID: String) async {
        let wasActive = pairingState.value.activeHostID == hostID
        hostStore.remove(id: hostID)
        try? tokens.removeToken(forHost: hostID)
        if wasActive {
            await activate(hostID: nil)
        } else {
            pairingState.update { $0.hosts = hostStore.hosts().map(PairedHost.init) }
        }
    }

    /// The camera takes only a `chro://pair` URL (a web link is the app's download QR);
    /// a paste may also be the bare code; a link is always the URL.
    static func offer(_ text: String, source: PairingSource) throws -> PairingOffer {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if source == .camera, trimmed.hasPrefix("https://") || trimmed.hasPrefix("http://") { throw PairingError.downloadCode }
        do {
            return try PairingOffer.decode(text, source: source == .paste ? .paste : .camera)
        } catch {
            throw source == .paste ? PairingError.invalidPastedCode : PairingError.invalidQRCode
        }
    }

    static func pairingError(_ error: Error, source: PairingSource) -> PairingError {
        switch error {
        case let error as PairingError: return error
        case let failure as PairingFailure:
            switch failure {
            case .invalidCode: return source == .paste ? .invalidPastedCode : .invalidQRCode
            case .codeRejected: return .rejected
            case .timedOut(let seconds): return .timedOut(seconds: seconds)
            case .incompatibleAPI: return .failed(LinkError.incompatibleAPI.errorDescription ?? "")
            case .credentialsUnavailable(let credential): return .failed("\(credential)")
            case .exchangeIncomplete(let reason), .failed(let reason): return .failed(reason)
            }
        default:
            return .failed(error.localizedDescription)
        }
    }
}

extension ChroServiceContainer {
    /// Every service over the paired desktop's link (one shared `LiveWorkspace`).
    public static func live(_ workspace: LiveWorkspace = LiveWorkspace()) -> ChroServiceContainer {
        ChroServiceContainer(sessions: workspace, projects: workspace, uiState: workspace, composer: workspace,
                             onboarding: workspace, pairing: workspace, conversation: workspace)
    }
}

extension HostConnection {
    /// What the screens show for a link state; nil for `stopped` (a switch, not a state of the host).
    init?(_ state: ChroLink.State) {
        switch state {
        case .connected: self = .connected
        case .authFailed: self = .authFailed
        case .incompatible: self = .incompatible
        case .idle, .connecting, .waiting: self = .connecting
        case .stopped: return nil
        }
    }
}
