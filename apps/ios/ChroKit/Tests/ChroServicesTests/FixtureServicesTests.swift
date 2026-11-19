import ChroDomain
import Foundation
import Testing
@testable import ChroServices

private let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)

private func workspace(_ scenario: FixtureScenario = .standard) -> FixtureWorkspace {
    FixtureWorkspace(scenario: scenario, now: { fixedNow }, titleDelay: .milliseconds(10))
}

private func first<T: Sendable>(_ stream: AsyncStream<T>) async -> T {
    var iterator = stream.makeAsyncIterator()
    return await iterator.next()!
}

/// The left panel the standard fixture produces is the one in mock slot 1.
struct CapturedWorkspaceTests {
    @Test func listMatchesMockSlotOne() async {
        let w = workspace()
        let sessions = await first(w.sessions())
        let prefs = await first(w.preferences())
        let projects = await first(w.projects())
        let layout = SessionListLayout(sessions: sessions, openProjects: projects.openProjects, scratchProjectIDs: projects.scratchProjectIDs,
                                       pins: prefs.pins, sortMode: prefs.sortMode, nestDelegations: prefs.nestDelegations, collapsedDelegations: [])
        #expect(layout.pinned.map(\.session.displayTitle) == ["Summarize stock module"])
        #expect(layout.projects.map(\.project.name) == ["inventory-service"])
        #expect(layout.projects[0].rows.map { String(repeating: ">", count: $0.depth) + $0.session.displayTitle } == [
            "Choose restock policy", "Long stock reconciliation run", "Write audit marker outside repo", "Add stock report images",
            "Reword README summary", "Add removeStock to stock module", ">Review removeStock in src/stock.ts for edge cases",
        ])
        #expect(layout.chats.isEmpty)
        let markers = layout.projects[0].rows.map { $0.session.marker(lastViewedAt: prefs.viewedAt[$0.session.id]) }
        #expect(markers == [nil, nil, nil, nil, .completedUnread, nil, .completedUnread])
        #expect(layout.pinned[0].session.marker(lastViewedAt: prefs.viewedAt[layout.pinned[0].session.id]) == nil)
        #expect(sessions.map { RelativeTime.format($0.updatedAt, now: fixedNow) } == ["now", "now", "now", "3m", "3m", "8m", "8m", "12m"])
    }

    @Test func paletteMatchesMockSlotTwo() async {
        let w = workspace()
        let sessions = await first(w.sessions())
        let prefs = await first(w.preferences())
        let sections = PaletteSections.build(query: "", commands: [PaletteCommand(id: "new-chat", label: "New chat")], sessions: sessions,
                                             projects: [], projectNameOf: { _ in "inventory-service" }, lastViewedAtOf: { prefs.viewedAt[$0] })
        let titles = sections.map { section in
            section.items.map { item -> String in
                if case .session(let s, _) = item { return s.displayTitle }
                return "command"
            }
        }
        #expect(titles == [["command"], ["Choose restock policy", "Write audit marker outside repo"], [
            "Long stock reconciliation run", "Add stock report images", "Reword README summary", "Add removeStock to stock module",
            "Review removeStock in src/stock.ts for edge cases", "Summarize stock module",
        ]])
    }

    @Test func freshHostsStartEmptyAndNotOnboarded() async throws {
        let w = workspace(.bareHost)
        #expect(await first(w.sessions()).isEmpty)
        #expect(await first(w.projects()).openProjects.isEmpty)
        #expect(try await w.isOnboardingComplete() == false)
        #expect(try await w.installStatus().agent(.claudeCode) == .notInstalled)
        #expect(try await w.installStatus().agent(.pi) == .installed(version: nil))
        #expect(try await workspace(.freshHost).installStatus().agent(.claudeCode).isInstalled)
    }
}

@Suite(.timeLimit(.minutes(1)))
struct FixtureSessionsTests {
    @Test func archiveAndRestoreMoveASessionBetweenListAndArchive() async throws {
        let w = workspace()
        try await w.archive(sessionID: "7a3f5d10-add")
        #expect(await first(w.sessions()).contains { $0.id == "7a3f5d10-add" } == false)
        let archived = try await w.archivedSessions(projectID: "inv", matching: "", offset: 0).sessions
        #expect(archived.map(\.id) == ["7a3f5d10-add"])
        #expect(archived[0].archivedAt == fixedNow)
        try await w.restore(sessionID: "7a3f5d10-add")
        #expect(try await w.archivedSessions(projectID: "inv", matching: "", offset: 0).sessions.isEmpty)
        #expect(await first(w.sessions()).map(\.id).contains("7a3f5d10-add"))
    }

    @Test func archivingStopsALiveSession() async throws {
        let w = workspace()
        try await w.archive(sessionID: "5c1e0f6a-pol")
        let entry = try await w.archivedSessions(projectID: "inv", matching: "", offset: 0).sessions[0]
        #expect(entry.session.isRunning == false)
        #expect(entry.session.awaitingInput == false)
    }

    @Test func unknownSessionsThrow() async {
        await #expect(throws: ServiceError.self) { try await workspace().archive(sessionID: "nope") }
        await #expect(throws: ServiceError.self) { try await workspace().restore(sessionID: "nope") }
    }

    @Test func startingASessionAddsARunningRowThenTitlesIt() async throws {
        let w = workspace()
        let session = try await w.startSession(NewSessionRequest(projectID: "inv", prompt: "Add a restock CLI. Keep it small.",
                                                                 runtime: RuntimeChoice(agent: .claudeCode, model: "Haiku 5.5"),
                                                                 baseBranch: "main", useWorktree: true))
        #expect(session.isRunning)
        #expect(session.title == nil)
        #expect(session.branch == "ch/\(session.shortID)-add-a-restock-cli-keep-it-sm")
        #expect(session.targetBranch == "main")
        #expect(await first(w.sessions()).first?.id == session.id)
        // The title arrives shortly after (the fixture's 10 ms); wait for it rather than a fixed time.
        for await sessions in w.sessions() where sessions.first?.title != nil {
            #expect(sessions.first?.title == "Add a restock CLI")
            break
        }
    }

    @Test func scratchAndLocalSessions() async throws {
        let w = workspace()
        let chat = try await w.startSession(NewSessionRequest(projectID: "general", prompt: "hi", runtime: RuntimeChoice(agent: .pi), baseBranch: nil, useWorktree: false))
        #expect(chat.branch == nil && chat.targetBranch == nil)
        let local = try await w.startSession(NewSessionRequest(projectID: "inv", prompt: "hi", runtime: RuntimeChoice(agent: .codex), baseBranch: "main", useWorktree: false))
        #expect(local.branch == "main")
        await #expect(throws: ServiceError.self) {
            try await w.startSession(NewSessionRequest(projectID: "inv", prompt: "  ", runtime: RuntimeChoice(agent: .codex), baseBranch: "main", useWorktree: true))
        }
    }

    @Test func continuingForksAnIdleSession() async throws {
        let w = workspace()
        let fork = try await w.continueSession(sessionID: "7a3f5d10-add", in: .newWorktree)
        #expect(fork.title == "Add removeStock to stock module (2)")
        #expect(fork.forkedFromTitle == "Add removeStock to stock module")
        #expect(fork.isRunning == false)
        #expect(fork.branch?.hasPrefix("ch/\(fork.shortID)-add-removestock-to-stock") == true)
        let same = try await w.continueSession(sessionID: "7a3f5d10-add", in: .sameCheckout)
        #expect(same.branch == "ch/e7a6-add-removestock-to-stock")
        #expect(await first(w.sessions()).prefix(2).map(\.id) == [same.id, fork.id])
        await #expect(throws: ServiceError.refused("Could not continue in a new session")) {
            try await w.continueSession(sessionID: "9b07c2d1-rec", in: .sameCheckout)
        }
        #expect(FixtureWorkspace.continuationTitle("Fix (2)") == "Fix (3)")
        #expect(FixtureWorkspace.continuationTitle("Fix (x)") == "Fix (x) (2)")
    }

    @Test func slugAndTitleRules() {
        #expect(FixtureWorkspace.slugify("  Fix: the README!! now  ") == "fix-the-readme-now")
        #expect(FixtureWorkspace.slugify("a".padding(toLength: 27, withPad: "a", startingAt: 0) + " bc") == String(repeating: "a", count: 27))
        #expect(FixtureWorkspace.title(from: "One.\nTwo") == "One")
    }
}

struct FixtureUIStateTests {
    @Test func pinTogglesAndViewedRecordsNow() async {
        let w = workspace()
        await w.togglePin(sessionID: "7a3f5d10-add")
        #expect(await first(w.preferences()).pins["7a3f5d10-add"] == fixedNow)
        await w.togglePin(sessionID: "7a3f5d10-add")
        #expect(await first(w.preferences()).pins["7a3f5d10-add"] == nil)
        await w.markViewed(sessionID: "c4534455-rw")
        #expect(await first(w.preferences()).viewedAt["c4534455-rw"] == fixedNow)
    }

    @Test func sortAndCollapsedSectionsPersist() async {
        let w = workspace()
        await w.setSortMode(.nameDescending)
        await w.setCollapsedSections([.chats])
        let prefs = await first(w.preferences())
        #expect(prefs.sortMode == .nameDescending)
        #expect(prefs.collapsedSections == [.chats])
    }

    @Test func subscribersSeeChanges() async {
        let w = workspace()
        var iterator = w.preferences().makeAsyncIterator()
        _ = await iterator.next()
        await w.setSortMode(.nameAscending)
        #expect(await iterator.next()?.sortMode == .nameAscending)
    }
}

struct FixtureProjectsTests {
    @Test func openingAFolderAddsItToSidebarAndRecents() async throws {
        let w = workspace()
        let project = try await w.openWorkspace(path: "/private/tmp/mm/iso2/repo/pricing-notes")
        #expect(project.id == "pricing")
        let state = await first(w.projects())
        #expect(state.openProjects.map(\.id) == ["inv", "pricing"])
        #expect(state.recents.map(\.id) == ["pricing", "inv"])
        let again = try await w.openWorkspace(path: "/private/tmp/mm/iso2/repo/inventory-service")
        #expect(again.id == "inv")
        #expect(await first(w.projects()).openProjects.count == 2)
    }

    @Test func removeAndColor() async throws {
        let w = workspace()
        try await w.setBadgeColor(projectID: "inv", color: "teal")
        #expect(await first(w.projects()).openProjects[0].badgeColor == "teal")
        #expect(ProjectBadgeColor.resolve("teal") == "#45A49B")
        #expect(ProjectBadgeColor.resolve("#123456") == "#123456")
        try await w.removeFromSidebar(projectID: "inv")
        #expect(await first(w.projects()).openProjects.isEmpty)
    }

    @Test func directoryBrowsing() async throws {
        let w = workspace()
        let home = try await w.homeDirectory()
        let listing = try await w.listDirectory(path: home)
        #expect(listing.entries.map(\.name) == ["inventory-service", "pricing-notes"])
        #expect(listing.entries[0].isGitRepository)
        await #expect(throws: ServiceError.unavailable("Failed to load directory")) { try await w.listDirectory(path: "/elsewhere") }
        #expect(DirectoryListing.parent(of: "/private/tmp") == "/private")
        #expect(DirectoryListing.parent(of: "/private") == "/")
        #expect(DirectoryListing.parent(of: "/") == nil)
    }

    @Test func branchesFilesSkillsModels() async throws {
        let w = workspace()
        let branches = try await w.branches(projectID: "inv")
        #expect(branches.first == BranchOption(name: "main", isCurrent: true))
        #expect(branches.map(\.name).contains("ch/e7a6-add-removestock-to-stock"))
        #expect(Set(branches.map(\.name)).count == branches.count)
        #expect(try await w.files(projectID: "inv", query: "TEST") == ["src/stock.test.ts"])
        #expect(try await w.skills(projectID: "inv").map(\.name) == ["chro"])
        #expect(try await w.models().count == 12)
        #expect(try await w.defaultRuntime() == RuntimeChoice(agent: .claudeCode))
        try await w.setDefaultAgent(.codex)
        #expect(try await w.defaultRuntime() == RuntimeChoice(agent: .codex))
    }
}

struct FixturePairingTests {
    static func offer(endpoint: String = "ws://192.168.1.40:6768", key: String = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg=") -> String {
        let json = #"{"v":2,"endpoint":"\#(endpoint)","deviceToken":"\#(String(repeating: "a", count: 48))","publicKeyB64":"\#(key)","scope":"mobile"}"#
        return Data(json.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    func run(_ w: FixtureWorkspace, _ code: String, _ source: PairingSource) async -> Result<[PairingProgress], PairingError> {
        var events: [PairingProgress] = []
        do {
            for try await event in w.pair(code: code, source: source) { events.append(event) }
            return .success(events)
        } catch let error as PairingError {
            return .failure(error)
        } catch {
            return .failure(.failed("\(error)"))
        }
    }

    @Test func aValidLinkPairsAndActivatesTheHost() async {
        let w = workspace(.unpaired)
        guard case .success(let events) = await run(w, "chro://pair?code=\(Self.offer())", .camera) else { Issue.record("pairing failed"); return }
        guard case .paired(let host) = events.last else { Issue.record("no host"); return }
        #expect(host.name == "Host 1")
        #expect(host.endpoint == "ws://192.168.1.40:6768")
        let state = await first(w.hosts())
        #expect(state.activeHost == host)
    }

    @Test func pasteAcceptsTheBareCodeButTheCameraDoesNot() async {
        #expect(await run(workspace(.unpaired), Self.offer(), .camera) == .failure(.invalidQRCode))
        if case .success = await run(workspace(.unpaired), "  \(Self.offer())\n", .paste) {} else { Issue.record("paste failed") }
        #expect(await run(workspace(.unpaired), "hello world", .paste) == .failure(.invalidPastedCode))
        #expect(await run(workspace(.unpaired), "https://apps.apple.com/app/chro", .camera) == .failure(.downloadCode))
    }

    @Test func aCodeIsSingleUse() async {
        let w = workspace(.unpaired)
        let code = "chro://pair?code=\(Self.offer())"
        _ = await run(w, code, .paste)
        #expect(await run(w, code, .paste) == .failure(.rejected))
    }

    @Test func rePairingTheSameDesktopKeepsOneRow() async {
        let w = workspace(.unpaired)
        _ = await run(w, Self.offer(endpoint: "ws://10.0.0.2:6768"), .paste)
        _ = await run(w, Self.offer(endpoint: "ws://100.64.0.9:6768"), .paste)
        let state = await first(w.hosts())
        #expect(state.hosts.count == 1)
        #expect(state.hosts[0].endpoint == "ws://100.64.0.9:6768")
    }

    @Test func removeAndActivate() async {
        let w = workspace()
        await w.activate(hostID: nil)
        #expect(await first(w.hosts()).activeHostID == nil)
        await w.activate(hostID: "host-1")
        #expect(await first(w.hosts()).activeHostID == "host-1")
        await w.activate(hostID: "missing")
        #expect(await first(w.hosts()).activeHostID == nil)
        await w.remove(hostID: "host-1")
        #expect(await first(w.hosts()).hosts.isEmpty)
    }

    @Test func messagesNameChro() {
        #expect(PairingError.invalidQRCode.message == "Not a valid Chro QR code")
        #expect(PairingError.timedOut(seconds: 25).message.hasPrefix("Couldn't connect within 25s"))
    }
}
