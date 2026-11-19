import ChroDomain
import ChroServices
import Foundation
import Observation

/// What the app shows: pair a desktop, pick one, set it up, or the workspace.
@MainActor @Observable
final class AppModel {
    enum Phase: Equatable {
        case loading
        case pairing
        case hostList
        case onboarding
        case workspace
    }

    let services: ChroServiceContainer
    let workspace: WorkspaceStore
    let router = Router()
    let sheets = SheetPresenter()
    let toasts = ToastCenter()
    let drafts = ComposerDrafts()

    private(set) var pairing: PairingState?
    private(set) var onboardingComplete: Bool?
    /// Pairing another desktop from the host list.
    var isAddingHost = false
    /// A `chro://pair` link the user confirmed; shown over everything while it pairs.
    var linkPairing: PairingModel?

    @ObservationIgnored private var subscription: Task<Void, Never>?
    @ObservationIgnored private var checkedHostID: String?

    init(services: ChroServiceContainer) {
        self.services = services
        workspace = WorkspaceStore(services: services)
    }

    var phase: Phase {
        guard let pairing else { return .loading }
        guard pairing.activeHost != nil else { return pairing.hosts.isEmpty || isAddingHost ? .pairing : .hostList }
        switch onboardingComplete {
        case nil: return .loading
        case false?: return .onboarding
        case true?: return .workspace
        }
    }

    func start() {
        guard subscription == nil else { return }
        subscription = Task { [weak self, services] in
            for await state in services.pairing.hosts() { await self?.receive(state) }
        }
    }

    private func receive(_ state: PairingState) async {
        pairing = state
        if state.activeHostID != nil { isAddingHost = false }
        guard state.activeHostID != checkedHostID else { return }
        checkedHostID = state.activeHostID
        onboardingComplete = nil
        router.reset(to: [])
        sheets.dismiss()
        guard state.activeHostID != nil else { workspace.stop(); return }
        workspace.start()
        onboardingComplete = (try? await services.onboarding.isOnboardingComplete()) ?? true
    }

    /// Onboarding finished (or skipped); land on the opened project when there is one.
    func finishOnboarding(landing: Route?) {
        onboardingComplete = true
        router.reset(to: landing.map { [$0] } ?? [])
    }

    /// A `chro://pair?code=` link: confirm, then pair over whatever is on screen.
    func handle(url: URL) {
        guard url.scheme?.lowercased() == "chro", url.host?.lowercased() == "pair" else { return }
        let code = url.absoluteString
        sheets.present {
            PairingConfirmSheet(code: code) { [weak self] in self?.pairFromLink(code) }
        }
    }

    private func pairFromLink(_ code: String) {
        let model = PairingModel(service: services.pairing)
        linkPairing = model
        model.pair(code, source: .link) { [weak self] _ in self?.linkPairing = nil }
    }
}
