import Foundation
import Testing
@testable import ChroDomain

/// Port of apps/desktop/src/workspace-layout/domain/palette-navigation.test.ts.
struct PaletteSectionsTests {
    static let updated = Date(timeIntervalSince1970: 1_784_419_200) // 2026-07-19T00:00:00Z

    func session(_ id: String, title: String? = nil, project: String = "p1", status: String = "completed", awaiting: Bool = false, running: Bool = false) -> SessionSummary {
        SessionSummary(id: id, shortID: id, projectID: project, title: title ?? "Session \(id)", status: status,
                       isRunning: running, awaitingInput: awaiting, agent: .claudeCode, updatedAt: Self.updated)
    }

    func build(query: String = "", commands: [PaletteCommand] = [PaletteCommand(id: "new-chat", label: "New chat")],
               sessions: [SessionSummary] = [], projects: [ProjectSummary] = [],
               projectNameOf: @escaping (String) -> String? = { _ in nil },
               lastViewedAtOf: @escaping (String) -> Date? = { _ in nil }) -> [PaletteSection] {
        PaletteSections.build(query: query, commands: commands, sessions: sessions, projects: projects,
                              projectNameOf: projectNameOf, lastViewedAtOf: lastViewedAtOf)
    }

    func section(_ sections: [PaletteSection], _ id: PaletteSectionID) -> PaletteSection? { sections.first { $0.id == id } }

    func sessionIDs(_ sections: [PaletteSection], _ id: PaletteSectionID) -> [String] {
        (section(sections, id)?.items ?? []).compactMap { if case .session(let s, _) = $0 { s.id } else { nil } }
    }

    func project(_ id: String, _ name: String) -> ProjectSummary { ProjectSummary(id: id, name: name, path: "/tmp/\(name)") }

    // Browsing

    @Test func browsingListsCommandsAttentionRecent() {
        let sections = build(sessions: [session("a", awaiting: true, running: true), session("b")],
                             lastViewedAtOf: { _ in Self.updated.addingTimeInterval(86_400) })
        #expect(sections.map(\.id) == [.commands, .attention, .recent])
        #expect(section(sections, .commands)?.items == [.command("new-chat")])
    }

    @Test func whitespaceQueryIsBrowsing() {
        let sections = build(query: "   ", sessions: [session("a")])
        #expect(section(sections, .recent) != nil)
        #expect(section(sections, .sessions) == nil)
    }

    @Test func blockedBeforeUnreadFailures() {
        let sections = build(sessions: [session("failed", status: "failed"), session("blocked", awaiting: true, running: true)])
        #expect(sessionIDs(sections, .attention) == ["blocked", "failed"])
        let flags = (section(sections, .attention)?.items ?? []).compactMap { if case .session(_, let f) = $0 { f } else { nil } }
        #expect(flags == [.needsInput, .failed])
    }

    @Test func viewedFailuresAreNotAttention() {
        let sections = build(sessions: [session("failed", status: "failed")], lastViewedAtOf: { _ in Self.updated.addingTimeInterval(3_600) })
        #expect(section(sections, .attention) == nil)
        #expect(sessionIDs(sections, .recent) == ["failed"])
    }

    @Test func runningSessionWithStoredFailureIsNotFlagged() {
        #expect(section(build(sessions: [session("rerun", status: "failed", running: true)]), .attention) == nil)
    }

    @Test func attentionIsCappedAndOverflowGoesToRecent() {
        let blocked = (0..<(PaletteSections.attentionMax + 2)).map { session("b\($0)", awaiting: true, running: true) }
        let sections = build(sessions: blocked + [session("plain")])
        #expect(sessionIDs(sections, .attention).count == PaletteSections.attentionMax)
        #expect(sessionIDs(sections, .recent) == ["b5", "b6", "plain"])
        if case .session(_, let flag) = section(sections, .recent)?.items.first { #expect(flag == .needsInput) } else { Issue.record("no session") }
    }

    @Test func recentIsCappedInRecencyOrder() {
        let sessions = (0..<(PaletteSections.recentMax + 3)).map { session("s\($0)") }
        #expect(sessionIDs(build(sessions: sessions), .recent) == sessions.prefix(PaletteSections.recentMax).map(\.id))
    }

    @Test func browsingOmitsProjects() {
        #expect(section(build(projects: [project("p1", "chro")]), .projects) == nil)
    }

    // Searching

    @Test func searchingReturnsCommandsProjectsSessionsWithoutEmpties() {
        let full = build(query: "chro", sessions: [session("a", title: "chro palette")], projects: [project("p1", "chro")])
        #expect(full.map(\.id) == [.projects, .sessions])
    }

    @Test func commandsMatchCaseInsensitively() {
        #expect(section(build(query: "NEW"), .commands)?.items == [.command("new-chat")])
    }

    @Test func titlePrefixBeatsSubstringBeatsProjectName() {
        let sections = build(query: "pal", sessions: [
            session("by-project", title: "Unrelated", project: "pp"),
            session("substr", title: "command palette"),
            session("prefix", title: "palette rework"),
        ], projectNameOf: { $0 == "pp" ? "palette-lab" : nil })
        #expect(sessionIDs(sections, .sessions) == ["prefix", "substr", "by-project"])
    }

    @Test func tiesKeepRecencyOrder() {
        let sections = build(query: "fix", sessions: [session("newer", title: "fix palette"), session("older", title: "fix dock")])
        #expect(sessionIDs(sections, .sessions) == ["newer", "older"])
    }

    @Test func nonMatchesAreDropped() {
        #expect(section(build(query: "zzz", sessions: [session("a", title: "nothing here")]), .sessions) == nil)
    }

    @Test func sessionResultsAreCapped() {
        let sessions = (0..<(PaletteSections.sessionResultsMax + 5)).map { session("s\($0)", title: "match \($0)") }
        #expect(sessionIDs(build(query: "match", sessions: sessions), .sessions).count == PaletteSections.sessionResultsMax)
    }

    @Test func projectPrefixBeatsSubstring() {
        let sections = build(query: "app", projects: [project("sub", "the-app"), project("pre", "appliance"), project("none", "unrelated")])
        let ids = (section(sections, .projects)?.items ?? []).compactMap { if case .project(let id) = $0 { id } else { nil } }
        #expect(ids == ["pre", "sub"])
    }

    @Test func projectResultsAreCapped() {
        let projects = (0..<(PaletteSections.projectResultsMax + 2)).map { project("x\($0)", "app-\($0)") }
        #expect(section(build(query: "app", projects: projects), .projects)?.items.count == PaletteSections.projectResultsMax)
    }

    @Test func searchResultsStillCarryFlags() {
        let sections = build(query: "match", sessions: [session("blocked", title: "match blocked", awaiting: true, running: true)])
        if case .session(_, let flag) = section(sections, .sessions)?.items.first { #expect(flag == .needsInput) } else { Issue.record("no session") }
    }

    @Test func headingsUseTheDesktopStrings() {
        #expect(PaletteSectionID.allCases.map(\.title) == ["Commands", "Needs attention", "Recent", "Projects", "Sessions"])
    }
}
