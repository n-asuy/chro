import ChroDomain
import ChroServices
import SwiftUI

/// Path links in a conversation (session/components/path-link.ts): a
/// path-like string becomes a link only after the desktop confirms it names
/// something that exists, so a shown link always opens. Candidates pass the
/// shape test (`PathLinkShape`) first; the survivors of one render are probed
/// in one batch. Hits stay resolved; a miss is retried after 30 seconds, as an
/// agent often writes a file moments after naming it.
///
/// The conversation reads the shared instance from `ExternalScreens.pathLinks`
/// (nil without the right-dock module): `target(_:in:)` while drawing,
/// `resolve(_:in:)` from a task, `open(_:…)` on tap.
@MainActor @Observable
final class PathLinks {
    /// What a session's references resolve against: its task's roots, else the project.
    struct Scope: Hashable, Sendable {
        var projectID: String
        var sessionID: String?
    }

    struct Target: Hashable, Sendable {
        var location: FileLocation
        var isDirectory: Bool
    }

    static let missLifetime: Duration = .seconds(30)
    /// Conversations can name unbounded distinct paths; keep the recent ones.
    static let capacity = 2048

    @ObservationIgnored private let files: any FilesService
    @ObservationIgnored private let clock = ContinuousClock()
    private var hits: [Key: Target] = [:]
    @ObservationIgnored private var misses: [Key: ContinuousClock.Instant] = [:]
    @ObservationIgnored private var inFlight: Set<Key> = []

    private struct Key: Hashable {
        var scope: Scope
        var text: String
    }

    nonisolated init(files: any FilesService) { self.files = files }

    /// The resolved target of `text`, nil until (or unless) the probe found it.
    func target(_ text: String, in scope: Scope) -> Target? {
        hits[Key(scope: scope, text: text.trimmingCharacters(in: .whitespaces))]
    }

    /// Probes every candidate not yet known, in one request.
    func resolve(_ texts: [String], in scope: Scope) async {
        let now = clock.now
        var pending: [String] = []
        for raw in texts {
            let text = raw.trimmingCharacters(in: .whitespaces)
            let key = Key(scope: scope, text: text)
            guard PathLinkShape.looksLikeFilePath(text), hits[key] == nil, !inFlight.contains(key), !pending.contains(text) else { continue }
            if let missed = misses[key], now - missed < Self.missLifetime { continue }
            pending.append(text)
        }
        guard !pending.isEmpty else { return }
        let keys = pending.map { Key(scope: scope, text: $0) }
        inFlight.formUnion(keys)
        defer { inFlight.subtract(keys) }
        let checkout: CheckoutScope = scope.sessionID.map { .run(sessionID: $0) } ?? .project(id: scope.projectID)
        // A failed probe leaves the text plain; the next render retries.
        guard let results = try? await files.probePaths(pending, in: checkout), results.count == pending.count else { return }
        let roots = await self.roots(scope)
        let resolvedAt = clock.now
        for (key, result) in zip(keys, results) {
            guard let relative = result.relative(toAnyOf: roots.map(\.path)), !relative.path.isEmpty else {
                misses[key] = resolvedAt
                continue
            }
            if hits.count >= Self.capacity, let evicted = hits.keys.first { hits[evicted] = nil }
            let root = roots[relative.rootIndex]
            hits[key] = Target(location: FileLocation(projectID: scope.projectID, sessionID: root.sessionID, path: relative.path, line: result.line),
                               isDirectory: result.kind == .directory)
        }
    }

    /// The checkouts the phone can open: the session's worktree (when it has one), then the project.
    private func roots(_ scope: Scope) async -> [(path: String, sessionID: String?)] {
        var roots: [(String, String?)] = []
        if let sessionID = scope.sessionID, let worktree = try? await files.checkoutRoot(.run(sessionID: sessionID)) {
            roots.append((worktree, sessionID))
        }
        if let project = try? await files.checkoutRoot(.project(id: scope.projectID)) { roots.append((project, nil)) }
        return roots
    }

    /// The link a resolved span carries in attributed text; `OpenURLAction` hands it back to `text(of:)`.
    nonisolated static func url(for text: String) -> URL? {
        var components = URLComponents()
        components.scheme = urlScheme
        components.path = text
        return components.url
    }

    nonisolated static func text(of url: URL) -> String? {
        guard url.scheme == urlScheme else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.path
    }

    nonisolated static let urlScheme = "chro-path"

    /// Files open in the file screen at their line; folders open the dock's Files at that folder.
    static func open(_ target: Target, router: Router, sheets: SheetPresenter, external: ExternalScreens) {
        if target.isDirectory {
            guard let dock = external.dock else { return }
            let context = DockContext(projectID: target.location.projectID, sessionID: target.location.sessionID, panel: .files,
                                      revealPath: target.location.path)
            sheets.present(tall: true) { dock(context) }
        } else {
            sheets.dismiss()
            router.push(.panel(.file(target.location)))
        }
    }
}

extension EnvironmentValues {
    /// The scope path links below resolve against; set by the conversation for its session.
    @Entry var pathLinkScope: PathLinks.Scope?
}

/// Resolves the path-like spans of a view, opens them on tap: the conversation's
/// glue to `ExternalScreens.pathLinks`. Views read `target(_:)` while drawing and
/// call `resolve(_:)` from a task.
@MainActor
struct PathLinkContext {
    let links: PathLinks?
    let scope: PathLinks.Scope?

    func target(_ text: String) -> PathLinks.Target? {
        guard let links, let scope else { return nil }
        return links.target(text, in: scope)
    }

    func resolve(_ texts: [String]) async {
        guard let links, let scope, !texts.isEmpty else { return }
        await links.resolve(texts, in: scope)
    }

    /// Of `texts`, those resolved to a target (for attributed text, which links them).
    func resolved(_ texts: [String]) -> Set<String> { Set(texts.filter { target($0) != nil }) }
}

extension View {
    /// Handles taps on resolved path links in this view's attributed text; other URLs go to the system.
    func openingPathLinks(_ context: PathLinkContext, router: Router, sheets: SheetPresenter, external: ExternalScreens) -> some View {
        environment(\.openURL, OpenURLAction { url in
            guard let text = PathLinks.text(of: url) else { return .systemAction }
            if let target = context.target(text) { PathLinks.open(target, router: router, sheets: sheets, external: external) }
            return .handled
        })
    }
}
