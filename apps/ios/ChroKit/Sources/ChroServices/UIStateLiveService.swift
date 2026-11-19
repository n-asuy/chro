import ChroAPI
import ChroDomain
import ChroLink
import Foundation

/// The desktop's UI state (`/rpc/ui-state`): one JSON object keyed by the
/// desktop's storage keys. `PUT` takes a partial object (null deletes a key)
/// and answers the whole state. The desktop reads it at launch, so changes
/// from the phone reach a running desktop on its next start.
extension LiveWorkspace {
    static let uiStatePath = "/rpc/ui-state"

    private struct UIStateEnvelope: Decodable {
        let uiState: [String: JSONValue]
        enum CodingKeys: String, CodingKey { case uiState = "ui_state" }
    }

    func reloadUIState() async {
        guard let state = try? await fetchUIState() else { return }
        replaceUIState(state)
    }

    func fetchUIState() async throws -> [String: JSONValue] {
        let body = try Self.successBody(try await send(RawRequest(path: Self.uiStatePath)))
        return try JSONDecoder().decode(UIStateEnvelope.self, from: body).uiState
    }

    /// Writes `changes` (nil deletes) and adopts the state the server answers.
    /// The local copy changes first so the screens update at once; a failed
    /// write reloads the server's state.
    func writeUIState(_ changes: [String: JSONValue?]) async throws {
        locked {
            for (key, value) in changes { uiState[key] = value }
        }
        publishUIState()
        let payload = JSONValue.object(changes.mapValues { $0 ?? .null })
        do {
            let response = try await send(RawRequest(method: .put, path: Self.uiStatePath, body: try JSONEncoder().encode(payload)))
            replaceUIState(try JSONDecoder().decode(UIStateEnvelope.self, from: Self.successBody(response)).uiState)
        } catch {
            await reloadUIState()
            throw error
        }
    }

    func uiValue(_ key: String) -> JSONValue? { locked { uiState[key] } }

    func replaceUIState(_ state: [String: JSONValue]) {
        locked {
            uiState = state
            uiStateLoaded = true
        }
        publishUIState()
    }

    private func publishUIState() {
        let (state, revision) = locked { (uiState, nextSnapshotRevision()) }
        preferenceState.publish(SessionListPreferences(uiState: state), revision: revision)
        publishProjects()
        followListPreferences()
    }

    /// `new Date().toISOString()`, as the desktop stores pin and read times.
    static func isoString(_ date: Date) -> String { RFC3339.string(date) }

    static func date(_ value: JSONValue) -> Date? {
        guard case .string(let text) = value else { return nil }
        return RFC3339.parse(text)
    }

    static func dateMap(_ value: JSONValue?) -> [String: Date] {
        guard case .object(let object)? = value else { return [:] }
        return object.compactMapValues(date)
    }
}

extension SessionListPreferences {
    /// The desktop's values: id → ISO time maps, the sort mode name, the
    /// collapsed section names, and nest-delegations (off unless set).
    init(uiState state: [String: JSONValue]) {
        var sortMode = SessionSortMode.recent
        if case .string(let raw)? = state[Key.sortMode], let mode = SessionSortMode(rawValue: raw) { sortMode = mode }
        var collapsed: Set<SessionListSection> = []
        if case .array(let names)? = state[Key.collapsedSections] {
            for case .string(let name) in names { if let section = SessionListSection(rawValue: name) { collapsed.insert(section) } }
        }
        var nest = false
        if case .bool(let value)? = state[Key.nestDelegations] { nest = value }
        self.init(
            pins: LiveWorkspace.dateMap(state[Key.pins]),
            viewedAt: LiveWorkspace.dateMap(state[Key.viewedAt]),
            sortMode: sortMode,
            collapsedSections: collapsed,
            nestDelegations: nest
        )
    }
}

extension LiveWorkspace: UIStateService {
    public func preferences() -> AsyncStream<SessionListPreferences> { preferenceState.stream() }

    public func togglePin(sessionID: String) async {
        var pins: [String: JSONValue] = [:]
        if case .object(let stored)? = uiValue(SessionListPreferences.Key.pins) { pins = stored }
        pins[sessionID] = pins[sessionID] == nil ? .string(Self.isoString(now())) : nil
        try? await writeUIState([SessionListPreferences.Key.pins: .object(pins)])
    }

    /// The read watermark only moves forward (session-read-store.ts).
    public func markViewed(sessionID: String) async {
        var marks: [String: JSONValue] = [:]
        if case .object(let stored)? = uiValue(SessionListPreferences.Key.viewedAt) { marks = stored }
        let at = now()
        if let previous = marks[sessionID].flatMap(Self.date), previous >= at { return }
        marks[sessionID] = .string(Self.isoString(at))
        try? await writeUIState([SessionListPreferences.Key.viewedAt: .object(marks)])
    }

    public func setSortMode(_ mode: SessionSortMode) async {
        try? await writeUIState([SessionListPreferences.Key.sortMode: .string(mode.rawValue)])
    }

    public func setCollapsedSections(_ sections: Set<SessionListSection>) async {
        // In the desktop's section order.
        let names = SessionListSection.allCases.filter(sections.contains).map { JSONValue.string($0.rawValue) }
        try? await writeUIState([SessionListPreferences.Key.collapsedSections: .array(names)])
    }
}
