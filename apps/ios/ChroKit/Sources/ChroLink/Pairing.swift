import CryptoKit
import Foundation

public enum PairingFailure: Error, Equatable, Sendable {
    /// The scanned or pasted text is not a chro pairing code.
    case invalidCode(PairingCodeSource)
    /// The desktop refused the code (expired, already used, replaced) or is not the QR's desktop.
    case codeRejected
    /// No connection within the pairing window.
    case timedOut(seconds: Int)
    /// The desktop's chro speaks another `apiGeneration`.
    case incompatibleAPI
    /// The token could not be written to the Keychain.
    case credentialsUnavailable(CredentialError)
    /// The desktop did not take the phone's token for the ticket: its reason, or why
    /// the last attempt went unanswered. The device row it authenticated stays on the
    /// desktop until revoked there.
    case exchangeIncomplete(String)
    case failed(String)
}

/// Milestones of one pairing, for the pairing log.
public enum PairingPhase: Equatable, Sendable {
    /// Opening the WebSocket to the offer's endpoint.
    case connecting(URL)
    /// The attempt could not open the socket; the link retries within the pairing window.
    case retrying(reason: String)
    /// The phone's own token, exchanged for the ticket, authenticated a connection.
    case authenticated
}

/// The capability a desktop advertises in `status.get` when it can exchange the QR ticket.
public enum PairingCapability {
    public static let ticketExchange = "pairing.ticket-exchange.v1"
}

/// Pairs with a desktop from its QR (spec §2.3, without the reference's ticket
/// fallback): authenticate with the QR ticket, `runtime.clientCapabilities.update`,
/// `status.get`, exchange the ticket for a token the phone proposes, then prove the
/// proposal by authenticating a connection with it, and only then save the token
/// (Keychain) and the host row. The QR ticket is never saved as the credential.
///
/// The proposal is kept in the token store (`proposalAccount`) until pairing completes, so an uncertain
/// outcome (the exchange's answer lost, the window over, the app gone) is retried
/// with the same token: the desktop accepts a repeated proposal and refuses another
/// one while it is pending.
public struct PairingCoordinator: Sendable {
    /// The whole pairing must finish within this window.
    public static let window: Duration = .seconds(25)
    /// One `pairing.exchangeTicket` attempt; an unanswered one is sent again.
    public static let exchangeAttemptTimeout: Duration = .seconds(6)

    private let hosts: HostStore
    private let tokens: any DeviceTokenStore
    private let connector: any LinkSocketConnector
    private let clock: any LinkClock
    private let random: any LinkRandom
    private let timing: LinkTiming
    private let now: @Sendable () -> Date

    public init(
        hosts: HostStore,
        tokens: any DeviceTokenStore,
        connector: any LinkSocketConnector = NetworkLinkSocketConnector(),
        clock: any LinkClock = SystemLinkClock(),
        random: any LinkRandom = SystemLinkRandom(),
        timing: LinkTiming = LinkTiming(),
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.hosts = hosts
        self.tokens = tokens
        self.connector = connector
        self.clock = clock
        self.random = random
        // One rejection is final while pairing: the code itself was refused.
        var timing = timing
        timing.maxRejections = 1
        self.timing = timing
        self.now = now
    }

    /// The token-store account holding the pending proposal: one at a time, as
    /// `<digest of the ticket>:<token>`, replaced by the next pairing, so an abandoned
    /// pairing leaves at most one entry and never the ticket itself.
    public static let proposalAccount = "pairing-proposal"

    static func ticketDigest(_ offer: PairingOffer) -> String {
        Data(SHA256.hash(data: Data(offer.deviceToken.utf8))).prefix(16).hexString
    }

    /// The proposal kept for `offer`'s ticket, if the pending one is for it.
    private func keptProposal(for offer: PairingOffer) throws -> String? {
        guard let stored = try tokens.token(forHost: Self.proposalAccount) else { return nil }
        let parts = stored.split(separator: ":", maxSplits: 1).map(String.init)
        return parts.count == 2 && parts[0] == Self.ticketDigest(offer) ? parts[1] : nil
    }

    static func proposalValue(_ token: String, for offer: PairingOffer) -> String { "\(ticketDigest(offer)):\(token)" }

    public func pair(_ text: String, source: PairingCodeSource, progress: @escaping @Sendable (PairingPhase) -> Void = { _ in }) async throws -> HostRecord {
        let offer: PairingOffer
        do {
            offer = try PairingOffer.decode(text, source: source)
        } catch {
            throw PairingFailure.invalidCode(source)
        }
        return try await pair(offer: offer, progress: progress)
    }

    public func pair(offer: PairingOffer, progress: @escaping @Sendable (PairingPhase) -> Void = { _ in }) async throws -> HostRecord {
        let account = Self.proposalAccount
        let earlier: String?
        let proposal: String
        do {
            earlier = try keptProposal(for: offer)
            proposal = earlier ?? random.bytes(24).hexString
            if earlier == nil { try tokens.setToken(Self.proposalValue(proposal, for: offer), forHost: account) }
        } catch let error as CredentialError {
            throw PairingFailure.credentialsUnavailable(error)
        }
        let ticketLink = link(offer, token: offer.deviceToken)
        let proposalLink = link(offer, token: proposal)
        let exchange = ExchangeProgress()
        let machineName: String?
        do {
            machineName = try await withDeadline(Self.window, clock: clock, onTimeout: {
                await ticketLink.stop()
                await proposalLink.stop()
            }) {
                progress(.connecting(offer.endpoint))
                let status: PairingStatus
                do {
                    try await Self.connect(ticketLink, progress: progress)
                    status = try await ticketLink.request("status.get", params: PairingStatus.Probe(), as: PairingStatus.self)
                } catch PairingFailure.codeRejected where earlier != nil {
                    // An earlier attempt may have committed the proposal, which retires the ticket.
                    await ticketLink.stop()
                    try await Self.connect(proposalLink, progress: progress)
                    progress(.authenticated)
                    return try await proposalLink.request("status.get", params: PairingStatus.Probe(), as: PairingStatus.self).machineName
                }
                // This product pairs only with desktops that exchange the ticket.
                guard status.capabilities?.contains(PairingCapability.ticketExchange) == true else { throw PairingFailure.incompatibleAPI }
                try await Self.exchange(ticketLink, proposal: proposal, progress: exchange)
                await ticketLink.stop()
                try await Self.connect(proposalLink, progress: progress)
                progress(.authenticated)
                return status.machineName
            }
        } catch is DeadlineExceeded {
            if let reason = exchange.lastFailure { throw PairingFailure.exchangeIncomplete(reason) }
            throw PairingFailure.timedOut(seconds: Int(Self.window.components.seconds))
        } catch {
            await ticketLink.stop()
            await proposalLink.stop()
            // A refusal is final for this proposal; anything else may have reached the desktop.
            if Self.isDefinitive(error) { try? tokens.removeToken(forHost: account) }
            throw Self.failure(error)
        }
        await ticketLink.stop()
        await proposalLink.stop()
        let saved = try save(offer: offer, token: proposal, machineName: machineName)
        try? tokens.removeToken(forHost: account)
        return saved
    }

    private func link(_ offer: PairingOffer, token: String) -> ChroLink {
        ChroLink(
            host: .init(endpoint: offer.endpoint, publicKey: offer.publicKey),
            deviceToken: token,
            connector: connector,
            clock: clock,
            random: random,
            timing: timing
        )
    }

    /// `pairing.exchangeTicket` with `proposal` until the desktop answers. An unanswered
    /// or interrupted attempt is repeated with the same proposal (the link reconnects with
    /// the ticket); an error answer ends pairing with the desktop's reason.
    private static func exchange(_ link: ChroLink, proposal: String, progress: ExchangeProgress) async throws {
        let params = try RPCCoding.encode(TicketExchange(deviceToken: proposal))
        while true {
            do {
                _ = try await link.request("pairing.exchangeTicket", params: params, timeout: exchangeAttemptTimeout)
                return
            } catch LinkError.rpc(let error) where error.code == RPCError.unauthorizedCode {
                throw PairingFailure.codeRejected
            } catch LinkError.rpc(let error) {
                throw PairingFailure.exchangeIncomplete(error.message)
            } catch LinkError.timeout {
                progress.record(LinkError.timeout.errorDescription ?? "timeout")
            } catch LinkError.disconnected {
                progress.record(LinkError.disconnected.errorDescription ?? "disconnected")
            }
        }
    }

    /// Starts the link and waits until it is connected or has given up.
    /// Reports each failed attempt with its reason, so a refused transport is visible
    /// in the pairing log instead of only as the window's timeout.
    private static func connect(_ link: ChroLink, progress: @Sendable (PairingPhase) -> Void) async throws {
        let states = await link.states()
        await link.start()
        for await state in states {
            switch state {
            case .connected: return
            case .authFailed: throw PairingFailure.codeRejected
            case .incompatible: throw PairingFailure.incompatibleAPI
            case .stopped: throw LinkError.stopped
            case .waiting:
                if let reason = await link.lastConnectFailure { progress(.retrying(reason: reason)) }
            case .idle, .connecting: continue
            }
        }
        throw LinkError.stopped
    }

    private static func isDefinitive(_ error: Error) -> Bool {
        switch error {
        case PairingFailure.codeRejected, PairingFailure.exchangeIncomplete, PairingFailure.incompatibleAPI: true
        default: false
        }
    }

    private static func failure(_ error: Error) -> PairingFailure {
        switch error {
        case let failure as PairingFailure: failure
        case LinkError.rpc(let error) where error.code == RPCError.unauthorizedCode: .codeRejected
        case LinkError.authFailed: .codeRejected
        default: .failed(RouteRequest.apiError(error).message)
        }
    }

    private func save(offer: PairingOffer, token: String, machineName: String?) throws -> HostRecord {
        let existing = hosts.host(publicKeyB64: offer.publicKeyB64)
        let id = existing?.id ?? "host-\(Int64((now().timeIntervalSince1970 * 1000).rounded()))"
        do {
            try tokens.setToken(token, forHost: id)
        } catch let error as CredentialError {
            throw PairingFailure.credentialsUnavailable(error)
        }
        let candidate = HostRecord(
            id: id,
            name: existing?.name ?? hosts.nextHostName(),
            endpoint: offer.endpoint,
            publicKey: offer.publicKey,
            lastConnected: now(),
            machineName: machineName
        )
        let (saved, replaced) = try hosts.upsert(candidate)
        for id in replaced { try? tokens.removeToken(forHost: id) }
        return saved
    }
}

private struct PairingStatus: Decodable, Sendable {
    struct Probe: Encodable, Sendable {}
    let capabilities: [String]?
    let machineName: String?
}

private struct TicketExchange: Encodable, Sendable {
    let deviceToken: String
}

/// The last reason an exchange attempt went unanswered, read when the window ends.
private final class ExchangeProgress: @unchecked Sendable {
    private let lock = NSLock()
    private var reason: String?
    func record(_ reason: String) { lock.withLock { self.reason = reason } }
    var lastFailure: String? { lock.withLock { reason } }
}
