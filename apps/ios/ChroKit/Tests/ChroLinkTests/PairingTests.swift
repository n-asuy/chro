import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// First pairing (spec §2.3): authenticate with the QR ticket, negotiate,
/// `status.get`, exchange the ticket for the phone's own token, then store.
struct PairingTests {
    let hosts = HostStore(defaults: UserDefaults(suiteName: "chro.tests.\(UUID().uuidString)")!)
    let tokens = MemoryTokenStore()
    let clock = ManualClock()
    static let pairedAt = Date(timeIntervalSince1970: 1_800_000_000.123)

    var offer: PairingOffer {
        PairingOffer(endpoint: LinkHarness.endpoint, deviceToken: FakeResponder.ticket, publicKey: LinkHarness.hostPublic, pairedDeviceId: "d-1", scope: "mobile")
    }

    private func coordinator(_ connector: FakeConnector, random: CountingRandom = CountingRandom()) -> PairingCoordinator {
        PairingCoordinator(hosts: hosts, tokens: tokens, connector: connector, clock: clock, random: random, now: { Self.pairedAt })
    }

    /// A desktop whose responders share one token book (the registry), so an
    /// exchange on the ticket's connection lets the proposal authenticate the next.
    private static func exchanging(_ answer: FakeResponder.Reply = .standard, capabilities: [String] = [FakeResponder.ticketExchangeCapability],
                                   book: FakeTokenBook = FakeTokenBook()) -> FakeConnector {
        FakeConnector { _ in
            .accept(FakeResponder(tokens: book) { request in
                switch request.method {
                case "status.get":
                    let list = capabilities.map { "\"\($0)\"" }.joined(separator: ",")
                    return .result("{\"capabilities\":[\(list)],\"machineName\":\"studio\"}")
                case "pairing.exchangeTicket": return answer
                default: return .standard
                }
            })
        }
    }

    @Test func pairsExchangesTheTicketAndStoresTheNewToken() async throws {
        let book = FakeTokenBook()
        let connector = Self.exchanging(book: book)
        let host = try await coordinator(connector).pair(offer: offer)
        let responder = try #require(connector.responders.first)
        #expect(responder.requests.map(\.method) == ["runtime.clientCapabilities.update", "status.get", "pairing.exchangeTicket"])
        let exchange = responder.requests("pairing.exchangeTicket")[0]
        #expect(Set(exchange.paramsObject.keys) == ["deviceToken"])
        let newToken = try #require(exchange.paramsObject["deviceToken"] as? String)
        #expect(newToken.count == 48 && newToken.allSatisfy { "0123456789abcdef".contains($0) })
        #expect(newToken != FakeResponder.ticket)
        #expect(exchange.deviceToken == FakeResponder.ticket)
        // Success waits for the new token to open a connection of its own, which retires the ticket.
        #expect(connector.responders.count == 2)
        #expect(connector.responders[1].authenticatedToken == newToken)
        #expect(!book.isLive(FakeResponder.ticket))

        #expect(host.id == "host-1800000000123")
        #expect(host.name == "Host 1")
        #expect(host.machineName == "studio")
        #expect(host.endpoint == LinkHarness.endpoint)
        #expect(host.publicKey == LinkHarness.hostPublic)
        #expect(host.lastConnected == Self.pairedAt)
        #expect(hosts.hosts() == [host])
        #expect(try tokens.token(forHost: host.id) == newToken)
        #expect(tokens.accounts == [host.id])
        // Both pairing connections are closed once done.
        try await eventually("pairing links closed") { connector.responders.allSatisfy { $0.closedByPhone != nil } }
    }

    @Test func progressReportsConnectingThenAuthenticated() async throws {
        let phases = PhaseLog()
        _ = try await coordinator(Self.exchanging()).pair(offer: offer) { phases.append($0) }
        #expect(phases.all == [.connecting(LinkHarness.endpoint), .authenticated])
    }

    @Test func progressReportsWhyAnAttemptFailedBeforeRetrying() async throws {
        // A transport that refuses at once (ATS, refused port) must not hide behind the 25 s window.
        let phases = PhaseLog()
        let book = FakeTokenBook()
        let connector = FakeConnector { attempt in attempt == 1 ? .refuse : .accept(FakeResponder(tokens: book)) }
        let pairing = coordinator(connector)
        let offer = self.offer
        let attempt = Task { try await pairing.pair(offer: offer) { phases.append($0) } }
        try await eventually("retry wait") { self.clock.remaining.contains(.milliseconds(500)) }
        clock.advance(by: .milliseconds(500))
        _ = try await attempt.value
        let reason = URLError(.cannotConnectToHost).localizedDescription
        #expect(phases.all == [.connecting(LinkHarness.endpoint), .retrying(reason: reason), .authenticated])
    }

    @Test func theDesktopsOwnExchangeIsAccepted() async throws {
        // The fake desktop's standard dispatcher (§4.1 strict params) instead of scripted answers.
        let book = FakeTokenBook()
        let connector = FakeConnector { _ in .accept(FakeResponder(tokens: book)) }
        let host = try await coordinator(connector).pair(offer: offer)
        #expect(book.exchanged == [try #require(try tokens.token(forHost: host.id))])
        #expect(connector.responders[0].violations.isEmpty)
    }

    @Test func theExchangedTokenOpensTheNextConnection() async throws {
        let connector = Self.exchanging()
        let host = try await coordinator(connector).pair(offer: offer)
        let token = try #require(try tokens.token(forHost: host.id))
        let next = FakeConnector { _ in .accept(FakeResponder(acceptedTokens: [token])) }
        let link = ChroLink(host: try #require(host.linkHost), deviceToken: token, connector: next, clock: clock, random: CountingRandom())
        await link.start()
        try await eventually("connected") { await link.state == .connected }
        #expect(next.responders[0].authenticatedToken == token)
        await link.stop()
    }

    @Test func aDesktopThatCannotExchangeTheTicketIsIncompatible() async throws {
        // The QR ticket is never kept as the phone's credential.
        let connector = Self.exchanging(capabilities: [])
        await #expect(throws: PairingFailure.incompatibleAPI) { try await coordinator(connector).pair(offer: offer) }
        #expect(connector.responders[0].requests("pairing.exchangeTicket").isEmpty)
        #expect(hosts.hosts().isEmpty)
        #expect(tokens.accounts.isEmpty)
    }

    @Test func aRefusedExchangeFailsWithTheDesktopsReasonAndStoresNothing() async throws {
        let connector = Self.exchanging(.error(code: "ticket_window_closed", message: "the ticket exchange window has closed"))
        await #expect(throws: PairingFailure.exchangeIncomplete("the ticket exchange window has closed")) {
            try await coordinator(connector).pair(offer: offer)
        }
        #expect(hosts.hosts().isEmpty)
        #expect(tokens.accounts.isEmpty)
        #expect(connector.responders.count == 1)
    }

    @Test func aLostExchangeAnswerIsRetriedWithTheSameToken() async throws {
        // The desktop recorded the proposal but its answer never arrived: the retry must
        // propose the same token (another one would be refused as `ticket_exchange_pending`).
        let book = FakeTokenBook()
        let lost = LockedCounter()
        let connector = FakeConnector { _ in
            .accept(FakeResponder(tokens: book) { request in
                request.method == "pairing.exchangeTicket" && lost.next() == 1 ? .standardAnswerLost : .standard
            })
        }
        let pairing = coordinator(connector)
        let offer = self.offer
        let attempt = Task { try await pairing.pair(offer: offer) }
        try await eventually("exchange attempt timer") { self.clock.remaining.contains(PairingCoordinator.exchangeAttemptTimeout) }
        clock.advance(by: PairingCoordinator.exchangeAttemptTimeout)
        let host = try await attempt.value
        let proposals = connector.responders[0].requests("pairing.exchangeTicket").compactMap { $0.paramsObject["deviceToken"] as? String }
        #expect(proposals.count == 2 && Set(proposals).count == 1)
        #expect(try tokens.token(forHost: host.id) == proposals[0])
        #expect(book.exchanged == [proposals[0]])
        #expect(connector.responders.allSatisfy { $0.violations.isEmpty })
    }

    @Test func tryingAgainAfterAnUncertainExchangeReusesTheProposal() async throws {
        // The first pairing runs out of time after the desktop recorded the proposal; scanning
        // the same QR again proposes the same token and completes.
        let book = FakeTokenBook()
        let first = FakeConnector { _ in
            .accept(FakeResponder(tokens: book) { $0.method == "pairing.exchangeTicket" ? .standardAnswerLost : .standard })
        }
        let pairing = coordinator(first)
        let offer = self.offer
        let attempt = Task { try await pairing.pair(offer: offer) }
        try await eventually("exchange attempt timer") { self.clock.remaining.contains(PairingCoordinator.exchangeAttemptTimeout) }
        clock.advance(by: PairingCoordinator.window)
        await #expect(throws: PairingFailure.self) { try await attempt.value }
        #expect(hosts.hosts().isEmpty)

        let again = Self.exchanging(book: book)
        // Another random source: a new proposal would differ from the pending one.
        let host = try await coordinator(again, random: CountingRandom(start: 101)).pair(offer: offer)
        let proposed = try #require(again.responders[0].requests("pairing.exchangeTicket").first?.paramsObject["deviceToken"] as? String)
        #expect(book.exchanged == [proposed])
        #expect(try tokens.token(forHost: host.id) == proposed)
        #expect(tokens.accounts == [host.id])
    }

    @Test func aProposalAlreadyCommittedCompletesWithoutTheTicket() async throws {
        // An earlier attempt exchanged the ticket and authenticated the proposal, then stopped
        // before saving: the ticket is retired, the stored proposal is the device's token.
        let book = FakeTokenBook()
        let earlier = Self.exchanging(book: book)
        let pairing = coordinator(earlier)
        _ = try await pairing.pair(offer: offer)
        let token = try #require(hosts.hosts().first.flatMap { try? tokens.token(forHost: $0.id) })
        hosts.remove(id: hosts.hosts()[0].id)
        try tokens.removeToken(forHost: "host-1800000000123")
        try tokens.setToken(PairingCoordinator.proposalValue(token, for: offer), forHost: PairingCoordinator.proposalAccount)

        let again = Self.exchanging(book: book)
        let host = try await coordinator(again).pair(offer: offer)
        #expect(try tokens.token(forHost: host.id) == token)
        #expect(again.responders.last?.authenticatedToken == token)
        #expect(tokens.accounts == [host.id])
    }

    @Test func anotherCodesProposalIsReplacedNotReused() async throws {
        // An abandoned pairing of another QR left its proposal: this one proposes its own.
        try tokens.setToken("0123456789abcdef0123456789abcdef:" + String(repeating: "ee", count: 24), forHost: PairingCoordinator.proposalAccount)
        let book = FakeTokenBook()
        let connector = Self.exchanging(book: book)
        let host = try await coordinator(connector).pair(offer: offer)
        let proposed = try #require(connector.responders[0].requests("pairing.exchangeTicket").first?.paramsObject["deviceToken"] as? String)
        #expect(proposed != String(repeating: "ee", count: 24))
        #expect(try tokens.token(forHost: host.id) == proposed)
        #expect(tokens.accounts == [host.id])
    }

    @Test func pairingFailsWhenTheNewTokenIsRefused() async throws {
        // The exchange answered, but the desktop refuses the new token (revoked meanwhile).
        let book = FakeTokenBook()
        let connector = FakeConnector { attempt in
            attempt == 1 ? .accept(FakeResponder(tokens: book)) : .accept(FakeResponder(behavior: .rejectAuth(code: "unauthorized")))
        }
        await #expect(throws: PairingFailure.codeRejected) { try await coordinator(connector).pair(offer: offer) }
        #expect(hosts.hosts().isEmpty)
        #expect(tokens.accounts.isEmpty)
    }

    @Test func rejectedCodeIsReportedAndNothingIsStored() async throws {
        let connector = FakeConnector { _ in .accept(FakeResponder(behavior: .rejectAuth(code: "unauthorized"))) }
        await #expect(throws: PairingFailure.codeRejected) { try await coordinator(connector).pair(offer: offer) }
        #expect(connector.attempts == 1)
        #expect(hosts.hosts().isEmpty)
    }

    @Test func aKeyThatIsNotTheQRsIsRejected() async throws {
        let impostor = FakeConnector { _ in .accept(FakeResponder(secretKey: Data(repeating: 0x55, count: 32))) }
        await #expect(throws: PairingFailure.codeRejected) { try await coordinator(impostor).pair(offer: offer) }
        #expect(hosts.hosts().isEmpty)
    }

    @Test func incompatibleDesktopIsReported() async throws {
        let connector = FakeConnector { _ in
            .accept(FakeResponder { $0.method == "runtime.clientCapabilities.update" ? .error(code: "incompatible_api", message: "2") : .standard })
        }
        await #expect(throws: PairingFailure.incompatibleAPI) { try await coordinator(connector).pair(offer: offer) }
    }

    @Test func pairingGivesUpAfterTwentyFiveSeconds() async throws {
        let connector = FakeConnector { _ in .hang }
        let pairing = coordinator(connector)
        let offer = self.offer
        let attempt = Task { try await pairing.pair(offer: offer) }
        try await eventually("pairing window and connect deadline") {
            self.clock.remaining.contains(.seconds(25)) && self.clock.remaining.contains(.seconds(12))
        }
        clock.advance(by: .seconds(12))
        try await eventually("retry wait") { self.clock.remaining.contains(.milliseconds(500)) }
        clock.advance(by: .milliseconds(500))
        try await eventually("second attempt") { connector.attempts == 2 }
        try await eventually("second connect deadline") { self.clock.remaining.contains(.seconds(12)) }
        clock.advance(by: .milliseconds(12_500))
        await #expect(throws: PairingFailure.timedOut(seconds: 25)) { try await attempt.value }
        #expect(hosts.hosts().isEmpty)
    }

    @Test func transportFailuresAreRetriedWithinTheWindow() async throws {
        let book = FakeTokenBook()
        let connector = FakeConnector { attempt in attempt == 1 ? .refuse : .accept(FakeResponder(tokens: book)) }
        let pairing = coordinator(connector)
        let offer = self.offer
        let attempt = Task { try await pairing.pair(offer: offer) }
        try await eventually("retry wait") { self.clock.remaining.contains(.milliseconds(500)) }
        clock.advance(by: .milliseconds(500))
        let host = try await attempt.value
        #expect(connector.attempts == 3)
        #expect(hosts.hosts().map(\.id) == [host.id])
    }

    @Test func pairingTextIsDecodedFirst() async throws {
        await #expect(throws: PairingFailure.invalidCode(.camera)) {
            try await coordinator(Self.exchanging()).pair("not a code", source: .camera)
        }
        let host = try await coordinator(Self.exchanging()).pair(offer.pairingURL.absoluteString, source: .camera)
        #expect(host.publicKey == LinkHarness.hostPublic)
    }

    @Test func rePairingTheSameDesktopKeepsItsRowAndName() async throws {
        let existing = HostRecord(id: "host-1", name: "Studio", endpoint: URL(string: "ws://10.0.0.5:6768")!, publicKey: LinkHarness.hostPublic, lastConnected: nil, machineName: nil)
        try hosts.upsert(existing)
        try tokens.setToken("old", forHost: "host-1")
        let host = try await coordinator(Self.exchanging()).pair(offer: offer)
        #expect(host.id == "host-1")
        #expect(host.name == "Studio")
        #expect(host.endpoint == LinkHarness.endpoint)
        #expect(hosts.hosts().count == 1)
        #expect(try tokens.token(forHost: "host-1") != "old")
    }

    @Test func newDesktopsGetTheNextFreeName() async throws {
        try hosts.upsert(HostRecord(id: "host-1", name: "Host 1", endpoint: URL(string: "ws://10.0.0.5:6768")!, publicKey: Data(repeating: 9, count: 32), lastConnected: nil, machineName: nil))
        let host = try await coordinator(Self.exchanging()).pair(offer: offer)
        #expect(host.name == "Host 2")
        #expect(hosts.hosts().count == 2)
    }
}

final class PhaseLog: @unchecked Sendable {
    private let lock = NSLock()
    private var phases: [PairingPhase] = []
    func append(_ phase: PairingPhase) { lock.withLock { phases.append(phase) } }
    var all: [PairingPhase] { lock.withLock { phases } }
}

final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func next() -> Int { lock.withLock { count += 1; return count } }
}
