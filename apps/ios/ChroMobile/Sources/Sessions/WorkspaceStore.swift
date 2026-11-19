import ChroDomain
import ChroServices
import Foundation
import Observation

/// The live workspace the left panel, the palette and Home read: sessions,
/// projects and the shared list preferences, kept current from the services'
/// streams, plus the left panel's own browsing state.
@MainActor @Observable
final class WorkspaceStore {
    let services: ChroServiceContainer

    /// The sessions the phone holds: on a host with the session list window, a window of its live sessions.
    private(set) var sessions: [SessionSummary] = []
    /// Live and archived sessions per project on the host, held or not.
    private(set) var counts: [String: SessionCounts] = [:]
    private(set) var projects = ProjectsState(openProjects: [], recents: [], scratchProjectIDs: [])
    private(set) var preferences = SessionListPreferences()
    private(set) var isLoaded = false

    /// The session last opened from the list: highlighted, with its relations drawn.
    var focusedSessionID: String?
    /// Browsing state, session-scoped like the desktop's.
    var collapsedProjects: Set<String> = []
    var collapsedDelegations: Set<String> = []
    var unfoldedGroups: Set<String> = []

    @ObservationIgnored private var subscriptions: [Task<Void, Never>] = []

    init(services: ChroServiceContainer) {
        self.services = services
    }

    func start() {
        guard subscriptions.isEmpty else { return }
        subscriptions = [
            Task { [weak self, services] in
                for await value in services.sessions.sessions() { self?.receive(sessions: value) }
            },
            Task { [weak self, services] in
                for await value in services.projects.projects() { self?.receive(projects: value) }
            },
            Task { [weak self, services] in
                for await value in services.uiState.preferences() { self?.receive(preferences: value) }
            },
            Task { [weak self, services] in
                for await value in services.sessions.sessionCounts() { self?.counts = value }
            },
        ]
    }

    @ObservationIgnored private var received: Set<String> = []

    private func receive(sessions value: [SessionSummary]) {
        sessions = value
        markReceived("sessions")
    }

    private func receive(projects value: ProjectsState) {
        projects = value
        markReceived("projects")
    }

    private func receive(preferences value: SessionListPreferences) {
        preferences = value
        markReceived("preferences")
    }

    private func markReceived(_ part: String) {
        received.insert(part)
        if !isLoaded, received.count == 3 { isLoaded = true }
    }

    func stop() {
        subscriptions.forEach { $0.cancel() }
        subscriptions = []
    }

    // MARK: Derived

    var layout: SessionListLayout {
        SessionListLayout(sessions: sessions, openProjects: projects.openProjects, scratchProjectIDs: projects.scratchProjectIDs,
                          pins: preferences.pins, sortMode: preferences.sortMode, nestDelegations: preferences.nestDelegations,
                          collapsedDelegations: collapsedDelegations)
    }

    var relatedSessionIDs: Set<String> { Set(RelatedSessions.ids(focus: focusedSessionID, in: sessions)) }

    func session(_ id: String) -> SessionSummary? { sessions.first { $0.id == id } }

    /// Live sessions of these projects the host has not sent yet.
    func unheld(in projectIDs: [String]) -> Int {
        projectIDs.reduce(0) { total, projectID in
            let held = sessions.lazy.filter { $0.projectID == projectID }.count
            return total + max(0, (counts[projectID]?.live ?? 0) - held)
        }
    }

    func hasArchived(_ projectID: String) -> Bool { (counts[projectID]?.archived ?? 0) > 0 }

    /// Live sessions of any project matching `query`, searched on the host.
    func searchSessions(_ query: String) async -> [SessionSummary] {
        (try? await services.sessions.searchSessions(matching: query)) ?? []
    }

    func project(_ id: String) -> ProjectSummary? { projects.project(id) }

    func isScratch(_ projectID: String) -> Bool { projects.scratchProjectIDs.contains(projectID) }

    /// The name a session row shows for its project; scratch chats read "Chats".
    func projectName(_ projectID: String) -> String? {
        isScratch(projectID) ? SessionListSection.chats.title : project(projectID)?.name
    }

    var scratchProjectID: String? { projects.scratchProjectIDs.sorted().first }

    /// New chat (use-new-chat.ts): ensures the General project on the host, which has
    /// none until the first chat, then opens the launcher on it.
    func openScratchChat(toasts: ToastCenter, open: @escaping @MainActor (String) -> Void) {
        Task { [services] in
            do {
                open(try await services.projects.ensureScratchProject())
            } catch {
                toasts.show("Failed to start session", description: (error as? ServiceError)?.message ?? error.localizedDescription)
            }
        }
    }

    func marker(for session: SessionSummary) -> StatusMarker? {
        session.marker(lastViewedAt: preferences.viewedAt[session.id])
    }

    func isPinned(_ id: String) -> Bool { preferences.pins[id] != nil }

    /// session-subline.ts for a row of the list.
    func subline(for row: SessionListRow, inPinned: Bool) -> Subline? {
        let session = row.session
        let delegator = session.delegatedFromID.flatMap { id in sessions.first { $0.id == id }?.displayTitle }
        return Subline.derive(
            SublineInput(note: session.note, summary: session.summary, forkedFromTitle: session.forkedFromTitle, delegatedFromTitle: delegator),
            isRunning: session.isRunning, showProject: inPinned, projectName: projectName(session.projectID),
            nestedUnderDelegator: row.depth > 0
        )
    }

    // MARK: Actions

    /// Opening a session records the view (clearing its unread marker) and focuses its row.
    func noteOpened(_ sessionID: String) {
        focusedSessionID = sessionID
        Task { [services] in
            // A search result outside the held window stays current while it is open.
            await services.sessions.holdSession(sessionID: sessionID)
            await services.uiState.markViewed(sessionID: sessionID)
        }
    }

    /// "Show more" past the held rows: the host sends the projects' next page.
    func showMore(in projectIDs: [String]) async throws {
        for projectID in projectIDs where unheld(in: [projectID]) > 0 {
            try await services.sessions.showMoreSessions(projectID: projectID)
        }
    }

    func togglePin(_ sessionID: String) {
        Task { await services.uiState.togglePin(sessionID: sessionID) }
    }

    func setSortMode(_ mode: SessionSortMode) {
        Task { await services.uiState.setSortMode(mode) }
    }

    func toggleSection(_ section: SessionListSection) {
        var sections = preferences.collapsedSections
        if sections.contains(section) { sections.remove(section) } else { sections.insert(section) }
        Task { await services.uiState.setCollapsedSections(sections) }
    }

    func toggleProject(_ projectID: String) {
        if collapsedProjects.contains(projectID) { collapsedProjects.remove(projectID) } else { collapsedProjects.insert(projectID) }
    }

    /// Collapse every project group, or expand them all when all are collapsed.
    func toggleAllProjects() {
        let ids = Set(layout.projects.map(\.project.id))
        collapsedProjects = ids.isSubset(of: collapsedProjects) ? collapsedProjects.subtracting(ids) : collapsedProjects.union(ids)
    }

    func toggleDelegation(_ sessionID: String) {
        if collapsedDelegations.contains(sessionID) { collapsedDelegations.remove(sessionID) } else { collapsedDelegations.insert(sessionID) }
    }

    func toggleUnfolded(_ groupKey: String) {
        if unfoldedGroups.contains(groupKey) { unfoldedGroups.remove(groupKey) } else { unfoldedGroups.insert(groupKey) }
    }

    func archive(_ sessionID: String) async throws {
        try await services.sessions.archive(sessionID: sessionID)
        if focusedSessionID == sessionID { focusedSessionID = nil }
    }
}
