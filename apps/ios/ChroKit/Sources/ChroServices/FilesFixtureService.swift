import ChroDomain
import Foundation

/// FilesService over the mock's checkouts. The ledger comes from the
/// captured sessions; every session is addressed to the project root, as in
/// the captures (none was started from a directory).
final class FilesFixtureService: FilesService, @unchecked Sendable {
    private let checkouts: DockFixtureCheckouts
    private let now: @Sendable () -> Date
    /// The shared "Hidden directories" setting (`show_hidden_entries`); the
    /// captured host had it on, so the mock's trees show `.claude` and `.git`.
    private let showsHiddenDirectories: Bool

    init(checkouts: DockFixtureCheckouts, now: @escaping @Sendable () -> Date = Date.init, showsHiddenDirectories: Bool = true) {
        self.checkouts = checkouts
        self.now = now
        self.showsHiddenDirectories = showsHiddenDirectories
    }

    private var sessions: [SessionSummary] { MockCapture.sessions(now: now()) }

    func checkoutRoot(_ scope: CheckoutScope) async throws -> String {
        switch scope {
        case .project(let id):
            guard let project = [MockCapture.inventory, MockCapture.pricing, MockCapture.general].first(where: { $0.id == id }) else {
                throw ServiceError.notFound("Project")
            }
            return project.path
        case .run(let sessionID):
            guard let branch = sessions.first(where: { $0.id == sessionID })?.branch else { throw ServiceError.notFound("Session") }
            return "/private/tmp/mm/iso/worktrees/\(branch)"
        }
    }

    func entries(_ scope: CheckoutScope) async throws -> [FileTreeEntry] {
        let checkout = try require(scope)
        let tree = FileTree(entries: checkout.nodes.map { FileTreeEntry(path: $0.key, isDirectory: $0.value.isDirectory) })
        return (showsHiddenDirectories ? tree : tree.hidingHiddenDirectories()).entries.sorted { $0.path < $1.path }
    }

    func changedPaths(sessionID: String) async throws -> [String] {
        let checkout = try require(.run(sessionID: sessionID))
        let current = checkout.nodes.filter { !$0.value.isDirectory }
        let base = checkout.base.filter { !$0.value.isDirectory }
        return Set(current.keys).union(base.keys).filter { current[$0] != base[$0] }.sorted()
    }

    func changes(_ scope: CheckoutScope) -> AsyncStream<Void> {
        let revisions = checkouts.revision.stream()
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                for await _ in revisions { continuation.yield() }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Search

    /// Folders the server's content walker never enters.
    private static let skippedFolders: Set<String> = [".git", "node_modules", "target", "dist", "build"]
    private static let maxLinesPerFile = 20

    func searchContent(projectID: String, query: String, matchCase: Bool, sort: FileSearchSort, limit: Int) async throws -> FileSearchResults {
        let compiled: FileSearchQuery
        do {
            compiled = try FileSearchQuery(query, caseSensitive: matchCase ? true : nil)
        } catch let error as FileSearchQuery.InvalidQuery {
            throw ServiceError.invalid(error.message)
        }
        guard !compiled.isEmpty, limit > 0 else { return .empty }
        let checkout = try require(.project(id: projectID))
        struct Ranked { var hit: FileSearchHit; var nameMatch: Bool; var count: Int }
        var collected: [Ranked] = []
        for (path, node) in checkout.nodes {
            guard case .text(let text) = node,
                  !path.split(separator: "/").dropLast().contains(where: { Self.skippedFolders.contains(String($0)) }) else { continue }
            let modified = checkout.modified[path]
            if !compiled.readsContent {
                if compiled.evaluate(name: path, lines: []) != nil {
                    collected.append(Ranked(hit: FileSearchHit(path: path, modifiedAt: modified), nameMatch: true, count: 0))
                }
                continue
            }
            let lines = text.components(separatedBy: "\n")
            let scanned = text.hasSuffix("\n") ? Array(lines.dropLast()) : lines
            guard let highlights = compiled.evaluate(name: path, lines: scanned) else { continue }
            let matches = highlights.keys.sorted().prefix(Self.maxLinesPerFile).map { number in
                let snippet = FileSearchSnippet.make(line: scanned[number - 1], ranges: highlights[number] ?? [])
                return FileLineMatch(lineNumber: number, text: snippet.text, ranges: snippet.ranges)
            }
            collected.append(Ranked(hit: FileSearchHit(path: path, lines: Array(matches), modifiedAt: modified),
                                    nameMatch: compiled.matchesName(path), count: highlights.count))
        }
        collected.sort { a, b in
            let byPath = a.hit.path < b.hit.path
            let nameA = a.hit.path.split(separator: "/").last.map { $0.lowercased() } ?? ""
            let nameB = b.hit.path.split(separator: "/").last.map { $0.lowercased() } ?? ""
            switch sort {
            case .relevance:
                if a.nameMatch != b.nameMatch { return a.nameMatch }
                if a.count != b.count { return a.count > b.count }
                if let order = Self.newerFirst(a.hit.modifiedAt, b.hit.modifiedAt) { return order }
                return byPath
            case .modifiedDescending: return Self.newerFirst(a.hit.modifiedAt, b.hit.modifiedAt) ?? byPath
            case .modifiedAscending: return Self.newerFirst(a.hit.modifiedAt, b.hit.modifiedAt, descending: false) ?? byPath
            case .nameAscending: return nameA != nameB ? nameA < nameB : byPath
            case .nameDescending: return nameA != nameB ? nameA > nameB : byPath
            case .pathAscending: return byPath
            case .pathDescending: return a.hit.path > b.hit.path
            }
        }
        return FileSearchResults(hits: collected.prefix(limit).map(\.hit), totalFiles: collected.count,
                                 totalLineMatches: collected.reduce(0) { $0 + $1.count }, truncated: false)
    }

    /// Whether `a` sorts before `b` by time (newest first unless ascending), missing times last; nil when equal.
    private static func newerFirst(_ a: Date?, _ b: Date?, descending: Bool = true) -> Bool? {
        switch (a, b) {
        case let (x?, y?): return x == y ? nil : (descending ? x > y : x < y)
        case (.some, nil): return true
        case (nil, .some): return false
        case (nil, nil): return nil
        }
    }

    func searchNames(projectID: String, query: String, limit: Int) async throws -> [FileSearchHit] {
        let needle = query.lowercased()
        let checkout = try require(.project(id: projectID))
        return checkout.nodes.map { FileTreeEntry(path: $0.key, isDirectory: $0.value.isDirectory) }
            .filter { !$0.path.split(separator: "/").contains { Self.skippedFolders.contains(String($0)) } }
            .filter { needle.isEmpty || $0.path.lowercased().contains(needle) }
            .sorted { ($0.name.lowercased().contains(needle) ? 0 : 1, $0.path.count, $0.path) < ($1.name.lowercased().contains(needle) ? 0 : 1, $1.path.count, $1.path) }
            .prefix(limit)
            .map { FileSearchHit(path: $0.path, isFile: !$0.isDirectory) }
    }

    // MARK: - Writes

    func createFile(projectID: String, path: String, content: String) async throws {
        try mutate(projectID) { checkout in
            guard checkout.nodes[path]?.isDirectory != true else { throw ServiceError.refused("\(path) is a folder") }
            Self.addParents(of: path, to: &checkout)
            checkout.nodes[path] = .text(content)
        }
    }

    func createDirectory(projectID: String, path: String) async throws {
        try mutate(projectID) { checkout in
            guard checkout.nodes[path] == nil else { throw ServiceError.refused("\(path) already exists") }
            Self.addParents(of: path, to: &checkout)
            checkout.nodes[path] = .directory
        }
    }

    func rename(projectID: String, from: String, to: String) async throws {
        try mutate(projectID) { checkout in
            guard checkout.nodes[from] != nil else { throw ServiceError.notFound(from) }
            guard checkout.nodes[to] == nil else { throw ServiceError.refused("\(to) already exists") }
            guard !to.hasPrefix(from + "/") else { throw ServiceError.refused("Cannot move a folder into itself") }
            checkout.nodes = Dictionary(uniqueKeysWithValues: checkout.nodes.map { (FileNaming.relocate($0.key, from: from, to: to), $0.value) })
            Self.addParents(of: to, to: &checkout)
        }
    }

    func copy(projectID: String, from: String, to: String) async throws {
        try mutate(projectID) { checkout in
            guard checkout.nodes[from] != nil else { throw ServiceError.notFound(from) }
            guard checkout.nodes[to] == nil else { throw ServiceError.refused("\(to) already exists") }
            for (path, node) in checkout.nodes where path == from || path.hasPrefix(from + "/") {
                checkout.nodes[FileNaming.relocate(path, from: from, to: to)] = node
            }
        }
    }

    func delete(projectID: String, path: String) async throws {
        try mutate(projectID) { checkout in
            guard checkout.nodes[path] != nil else { throw ServiceError.notFound(path) }
            checkout.nodes = checkout.nodes.filter { $0.key != path && !$0.key.hasPrefix(path + "/") }
        }
    }

    // MARK: - Agent

    func directoryAgent(projectID: String, path: String) async throws -> DirectoryAgentInfo {
        let checkout = try require(.project(id: projectID))
        let directory = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let files = Set(checkout.nodes.filter { !$0.value.isDirectory }.keys)
        let ledger: [DirectoryAgentInfo.Entry] = directory.isEmpty
            ? sessions.filter { $0.projectID == projectID }
                .sorted { $0.updatedAt > $1.updatedAt }
                .compactMap { session in
                    guard !session.isRunning, let outcome = LedgerOutcome(status: session.status, merged: false) else { return nil }
                    return .init(sessionID: session.id, title: session.displayTitle, summary: session.summary, outcome: outcome, updatedAt: session.updatedAt)
                }
            : []
        return DirectoryAgentInfo(path: directory, brief: DirectoryBrief.find(in: directory, files: files),
                                  inheritedBrief: DirectoryBrief.inherited(by: directory, files: files), ledger: ledger)
    }

    // MARK: - Helpers

    /// routes/rpc/path_link.rs over the fixture checkouts: the reference
    /// verbatim, then without a `:line[:col]` suffix; absolute paths must lie
    /// in a root, relative ones are joined to each root in order (a session's
    /// worktree, then its project's main checkout).
    func probePaths(_ references: [String], in scope: CheckoutScope) async throws -> [PathProbeResult] {
        var roots: [(scope: CheckoutScope, path: String)] = [(scope, try await checkoutRoot(scope))]
        if case .run(let sessionID) = scope, let projectID = sessions.first(where: { $0.id == sessionID })?.projectID {
            roots.append((.project(id: projectID), try await checkoutRoot(.project(id: projectID))))
        }
        return references.map { reference in
            let trimmed = reference.trimmingCharacters(in: .whitespaces)
            let split = PathLinkShape.splitPosition(trimmed)
            var forms = [PathLinkShape.Position(path: trimmed, line: nil, column: nil)]
            if split.path != trimmed { forms.append(split) }
            for form in forms {
                for root in roots {
                    let relative: String
                    if form.path.hasPrefix("/") {
                        guard form.path.hasPrefix(root.path + "/") else { continue }
                        relative = String(form.path.dropFirst(root.path.count + 1))
                    } else {
                        relative = form.path.hasPrefix("./") ? String(form.path.dropFirst(2)) : form.path
                    }
                    guard let node = checkouts.checkout(root.scope)?.nodes[relative] else { continue }
                    return PathProbeResult(exists: true, kind: node.isDirectory ? .directory : .file,
                                           absolutePath: root.path + "/" + relative, root: root.path, relativePath: relative,
                                           line: form.line, column: form.column)
                }
            }
            return PathProbeResult(exists: false)
        }
    }

    private func require(_ scope: CheckoutScope) throws -> FixtureCheckout {
        guard let checkout = checkouts.checkout(scope) else { throw ServiceError.notFound("Checkout") }
        return checkout
    }

    private func mutate(_ projectID: String, _ change: (inout FixtureCheckout) throws -> Void) throws {
        guard try checkouts.update(.project(id: projectID), change) != nil else { throw ServiceError.notFound("Project") }
    }

    private static func addParents(of path: String, to checkout: inout FixtureCheckout) {
        for folder in FileTree.ancestors(of: path) where checkout.nodes[folder] == nil { checkout.nodes[folder] = .directory }
    }
}
