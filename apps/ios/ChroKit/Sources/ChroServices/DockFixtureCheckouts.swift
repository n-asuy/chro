import Foundation

/// One file or folder of a fixture checkout.
enum FixtureNode: Equatable, Sendable {
    case directory
    case text(String)
    case binary(Data, contentType: String)

    var isDirectory: Bool { self == .directory }

    var text: String? { if case .text(let text) = self { text } else { nil } }
}

/// A checkout's files keyed by root-relative path, plus the merge-base
/// content its diff compares against (runs only).
struct FixtureCheckout: Equatable, Sendable {
    var nodes: [String: FixtureNode]
    /// Path → content at the merge base; a path missing here was added by the run.
    var base: [String: FixtureNode] = [:]
    /// Modification order, newest first (the gallery sorts by it).
    var modified: [String: Date] = [:]

    var files: [String] { nodes.filter { !$0.value.isDirectory }.map(\.key).sorted() }
}

/// The checkouts of the mock's two captures, shared by the fixture Files,
/// Editor, Source Control, Diff and Gallery services so an edit in one shows
/// up in the others. Contents are the captured text; what the captures did
/// not include is hand-made and marked `handMade` below.
final class DockFixtureCheckouts: @unchecked Sendable {
    private let lock = NSLock()
    private var checkouts: [CheckoutScope: FixtureCheckout]
    /// Bumped on every change, so a fixture "watcher" can re-read.
    let revision = ServiceBroadcast(0)

    init() { checkouts = DockFixtureCheckouts.captured() }

    func checkout(_ scope: CheckoutScope) -> FixtureCheckout? {
        lock.lock()
        defer { lock.unlock() }
        return checkouts[scope]
    }

    /// Mutates one checkout; returns what the change returned.
    @discardableResult
    func update<T>(_ scope: CheckoutScope, _ change: (inout FixtureCheckout) throws -> T) rethrows -> T? {
        lock.lock()
        guard var checkout = checkouts[scope] else { lock.unlock(); return nil }
        let result: T
        do {
            result = try change(&checkout)
        } catch {
            lock.unlock()
            throw error
        }
        checkouts[scope] = checkout
        lock.unlock()
        revision.update { $0 += 1 }
        return result
    }

    // MARK: - Captured data

    /// Session IDs of the runs that have their own worktree (SessionsFixtureData).
    enum Run {
        static let added = "7a3f5d10-add"
        static let review = "b41c8e33-rev"
        static let summarize = "4a53c7f9-sum"
        static let images = "bd50a1e2-img"
        static let reworded = "c4534455-rw"
    }

    static let inventoryProjectID = "inv"
    static let pricingProjectID = "pricing"

    /// Paths of the main checkout whose content is hand-made (no capture of them exists):
    /// every `docs/*` file, made so the non-text viewers and prose features have something to open.
    static let handMadePrefix = "docs/"

    private static func captured() -> [CheckoutScope: FixtureCheckout] {
        let first = FixtureCheckout(
            nodes: lines([
                "src/stock.ts": Content.stockTS,
                "src/stock.test.ts": Content.stockTestTS,
                "README.md": Content.readmeNew,
            ], directories: [".git", "src"]),
            base: lines(["src/stock.ts": Array(Content.stockTS.prefix(5)) + [""], "README.md": Content.readmeOld], directories: [])
        )
        var images = FixtureCheckout(
            nodes: lines([
                ".claude/skills/restock-check/SKILL.md": Content.skillMD,
                "README.md": Content.readmeReworded,
                "src/stock.ts": Content.stockTSMain,
            ], directories: [".git", ".claude", ".claude/skills", ".claude/skills/restock-check", "docs", "docs/images", "src"]),
            base: lines([
                ".claude/skills/restock-check/SKILL.md": Content.skillMD,
                "README.md": Content.readmeReworded,
                "src/stock.ts": Content.stockTSMain,
            ], directories: [])
        )
        // Gallery order as captured: newest modified first.
        let media: [(String, Data)] = [
            ("docs/images/sku-heatmap.png", DockFixtureMedia.skuHeatmap),
            ("docs/images/warehouse-badge.svg", DockFixtureMedia.warehouseBadge),
            ("docs/images/stock-trend.svg", DockFixtureMedia.stockTrend),
        ]
        let capturedAt = Date(timeIntervalSince1970: 1_763_130_000)
        for (index, (path, data)) in media.enumerated() {
            images.nodes[path] = .binary(data, contentType: "image/png")
            images.modified[path] = capturedAt.addingTimeInterval(-Double(index) * 60)
        }
        let reworded = FixtureCheckout(
            nodes: lines(["README.md": Content.readmeRewordedNew, "src/stock.ts": Content.stockTSMain], directories: [".git", "src"]),
            base: lines(["README.md": Content.readmeReworded, "src/stock.ts": Content.stockTSMain], directories: [])
        )
        var main = FixtureCheckout(
            nodes: lines(Content.mainFiles, directories: [".claude", ".claude/skills", ".claude/skills/restock-check", ".git", "docs", "docs/report", "docs/skus", "src"])
        )
        main.nodes["docs/report/heatmap.png"] = .binary(DockFixtureMedia.skuHeatmap, contentType: "image/png")
        main.nodes["docs/stock-report.pdf"] = .binary(Content.stockReportPDF, contentType: "application/pdf")
        main.nodes["docs/warehouse-layout.excalidraw"] = .text(Content.warehouseLayoutScene)
        let pricing = FixtureCheckout(nodes: ["notes.md": .text("")])
        return [
            .run(sessionID: Run.added): first,
            // The mock gives the review and the failed run the first capture's files but no diff.
            .run(sessionID: Run.review): FixtureCheckout(nodes: first.nodes, base: first.nodes),
            .run(sessionID: Run.summarize): FixtureCheckout(nodes: first.nodes, base: first.nodes),
            .run(sessionID: Run.images): images,
            .run(sessionID: Run.reworded): reworded,
            .project(id: inventoryProjectID): main,
            .project(id: pricingProjectID): pricing,
        ]
    }

    private static func lines(_ files: [String: [String]], directories: [String]) -> [String: FixtureNode] {
        var nodes = Dictionary(uniqueKeysWithValues: files.map { ($0.key, FixtureNode.text($0.value.joined(separator: "\n"))) })
        for directory in directories { nodes[directory] = .directory }
        return nodes
    }
}
