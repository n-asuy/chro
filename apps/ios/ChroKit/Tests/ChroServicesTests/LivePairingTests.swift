import ChroAPI
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// PairingService over the link: `chro://pair?code=` decoding, the E2EE v2
/// pairing with ticket exchange, the Keychain token and the active host.
@Suite(.timeLimit(.minutes(1)))
struct LivePairingTests {
    let desktop = FakeDesktop()

    private var offerURL: String {
        PairingOffer(endpoint: FakeDesktop.endpoint, deviceToken: FakeResponder.ticket, publicKey: LinkHarness.hostPublic).pairingURL.absoluteString
    }

    private func collect(_ stream: AsyncThrowingStream<PairingProgress, Error>) async throws -> [PairingProgress] {
        var seen: [PairingProgress] = []
        for try await progress in stream { seen.append(progress) }
        return seen
    }

    @Test func pairingStoresTheExchangedTokenAndConnectsWithIt() async throws {
        let phone = try desktop.phone(paired: false)
        #expect(phone.workspace.pairingState.value == PairingState(hosts: [], activeHostID: nil))
        let progress = try await collect(phone.workspace.pair(code: offerURL, source: .camera))
        #expect(progress.dropLast() == [
            .step("Opening connection to ws://192.168.1.23:6768"), .step("Encrypted channel ready"), .step("Device authenticated"),
        ])
        guard case .paired(let host)? = progress.last else {
            Issue.record("not paired: \(progress)")
            return
        }
        #expect(host.name == "Host 1")
        #expect(host.endpoint == "ws://192.168.1.23:6768")
        #expect(phone.workspace.pairingState.value.activeHostID == host.id)
        #expect(phone.workspace.pairingState.value.hosts.map(\.id) == [host.id])
        let token = try #require(try phone.tokens.token(forHost: host.id))
        #expect(desktop.tokens.exchanged == [token])
        #expect(phone.defaults.string(forKey: ActiveHostSetting.key) == host.id)
        // The workspace now runs on the new token.
        try await eventually("subscribed with the exchanged token") {
            desktop.responders.contains { $0.authenticatedToken == token && !$0.subscriptions.isEmpty }
        }
        #expect(desktop.violations.isEmpty)
    }

    @Test func anIncompleteExchangeIsAPairingFailureWithTheDesktopsReason() {
        let error = LiveWorkspace.pairingError(PairingFailure.exchangeIncomplete("the ticket exchange window has closed"), source: .camera)
        #expect(error == .failed("the ticket exchange window has closed"))
        #expect(error.message == "Pairing failed: the ticket exchange window has closed")
    }

    @Test func aFailedAttemptIsLoggedWithItsReason() {
        #expect(LiveWorkspace.logLines(.retrying(reason: "The resource could not be loaded")) == ["Couldn't connect: The resource could not be loaded. Retrying…"])
    }

    @Test func theCameraRejectsTheDownloadLinkAndOtherText() async throws {
        let phone = try desktop.phone(paired: false)
        await #expect(throws: PairingError.downloadCode) { try await collect(phone.workspace.pair(code: "https://chro.ai/download", source: .camera)) }
        await #expect(throws: PairingError.invalidQRCode) { try await collect(phone.workspace.pair(code: "hello", source: .camera)) }
        await #expect(throws: PairingError.invalidPastedCode) { try await collect(phone.workspace.pair(code: "!!!", source: .paste)) }
        #expect(desktop.responders.isEmpty)
    }

    @Test func aPastedBareCodePairs() async throws {
        let phone = try desktop.phone(paired: false)
        let code = try #require(URLComponents(string: offerURL)?.queryItems?.first?.value)
        let progress = try await collect(phone.workspace.pair(code: code, source: .paste))
        guard case .paired = progress.last else {
            Issue.record("not paired")
            return
        }
    }

    @Test func aUsedOrExpiredCodeIsRejected() async throws {
        desktop.tokens.revoke(FakeResponder.ticket)
        let phone = try desktop.phone(paired: false)
        await #expect(throws: PairingError.rejected) { try await collect(phone.workspace.pair(code: offerURL, source: .camera)) }
        #expect(phone.hosts.hosts().isEmpty)
    }

    @Test func removingTheActiveHostForgetsItsTokenAndDisconnects() async throws {
        let phone = try desktop.phone()
        try await eventually("connected") { desktop.responders.first?.subscriptions.isEmpty == false }
        #expect(phone.workspace.pairingState.value.activeHostID == "host-1")
        await phone.workspace.remove(hostID: "host-1")
        #expect(phone.workspace.pairingState.value == PairingState(hosts: [], activeHostID: nil))
        #expect(try phone.tokens.token(forHost: "host-1") == nil)
        try await eventually("link closed") { desktop.responders.first?.closedByPhone != nil }
        await #expect(throws: ServiceError.self) { try await phone.workspace.installStatus() }
    }

    /// Found on a real server: after the desktop revoked the phone, the app kept showing the
    /// workspace with no sign of it. The active host's connection state is the screens' input.
    @Test func aRevokedPhoneReportsAuthFailedAndRetryReconnects() async throws {
        let phone = try desktop.phone()
        try await eventually("connected") { phone.workspace.pairingState.value.connection == .connected }
        desktop.tokens.revoke(FakeDesktop.token)
        desktop.responders.first?.close(code: 1006, reason: "")
        try await eventually("auth failed after three refusals") {
            for wait in desktop.clock.remaining where wait < .seconds(10) { desktop.clock.advance(by: wait) }
            return phone.workspace.pairingState.value.connection == .authFailed
        }
        desktop.tokens.accept(FakeDesktop.token)
        await phone.workspace.reconnect()
        try await eventually("connected again") { phone.workspace.pairingState.value.connection == .connected }
    }

    @Test func activatingNoneDisconnectsAndActivatingAgainReconnects() async throws {
        let phone = try desktop.phone()
        try await eventually("connected") { desktop.responders.count == 1 && desktop.responders[0].subscriptions.count == 1 }
        await phone.workspace.activate(hostID: nil)
        #expect(phone.workspace.pairingState.value.activeHostID == nil)
        try await eventually("closed") { desktop.responders[0].closedByPhone != nil }
        await phone.workspace.activate(hostID: "host-1")
        try await eventually("reconnected") { desktop.responders.count == 2 && desktop.responders[1].subscriptions.count == 1 }
        #expect(phone.hosts.host(id: "host-1")?.lastConnected != nil)
    }

    @Test func theLiveContainerUsesOneWorkspaceForEveryService() throws {
        let phone = try desktop.phone()
        let container = ChroServiceContainer.live(phone.workspace)
        #expect(container.sessions as? LiveWorkspace === phone.workspace)
        #expect(container.pairing as? LiveWorkspace === phone.workspace)
        #expect(container.onboarding as? LiveWorkspace === phone.workspace)
    }
}
