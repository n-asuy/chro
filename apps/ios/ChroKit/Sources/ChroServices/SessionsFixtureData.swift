import ChroDomain
import Foundation

/// Which captured state the fixture services start in. `standard` is the
/// workspace of the HTML mock; the onboarding scenarios are its fresh hosts.
public enum FixtureScenario: String, Sendable, CaseIterable {
    /// Paired, set up, the inventory-service project with the captured sessions.
    case standard
    /// Paired with a fresh host: onboarding not done, nothing open (mock slot 13).
    case freshHost = "fresh-host"
    /// A fresh host without Claude Code on its PATH (mock slot 14).
    case bareHost = "bare-host"
    /// No desktop paired yet.
    case unpaired
}

/// The data of the HTML mock (`.claude/mocks/mobile-companion`), captured
/// from two isolated chro instances (v0.1.57) and merged into one project.
/// Times are relative to `now` so the list reads "now", "3m", "8m", "12m".
enum MockCapture {
    static let general = ProjectSummary(id: "general", name: "Chats", path: "/private/tmp/mm/iso/chats", isGitRepository: false)
    static let inventory = ProjectSummary(id: "inv", name: "inventory-service", path: "/private/tmp/mm/iso/inventory-service")
    static let pricing = ProjectSummary(id: "pricing", name: "pricing-notes", path: "/private/tmp/mm/iso2/repo/pricing-notes", isGitRepository: false)
    static let worktree = "/private/tmp/mm/iso/worktrees/ch/e7a6-add-removestock-to-stock"

    static func sessions(now: Date) -> [SessionSummary] {
        func ago(minutes: Double, seconds: Double = 0) -> Date { now.addingTimeInterval(-(minutes * 60 + seconds)) }
        return [
            SessionSummary(id: "5c1e0f6a-pol", shortID: "5c1e", projectID: "inv", title: "Choose restock policy", status: "in_progress",
                           isRunning: true, awaitingInput: true,
                           summary: "The loop printed all 60 lines (scanning sku 1 through scanning sku 60).",
                           agent: .claudeCode, model: "Haiku 5.5", branch: "ch/6c96-choose-restock-policy", targetBranch: "main",
                           updatedAt: ago(minutes: 0, seconds: 1)),
            SessionSummary(id: "9b07c2d1-rec", shortID: "9b07", projectID: "inv", title: "Long stock reconciliation run", status: "in_progress",
                           isRunning: true, summary: "All 60 batches printed (reconcile batch 1 through reconcile batch 60).",
                           agent: .claudeCode, model: "Haiku 5.5", branch: "ch/6d40-long-stock-reconciliation-run", targetBranch: "main",
                           updatedAt: ago(minutes: 0, seconds: 2)),
            SessionSummary(id: "e4a2b9c0-aud", shortID: "e4a2", projectID: "inv", title: "Write audit marker outside repo", status: "in_progress",
                           isRunning: true, awaitingInput: true, agent: .codex, branch: "ch/67e6-write-audit-marker-outside", targetBranch: "main",
                           updatedAt: ago(minutes: 0, seconds: 3)),
            SessionSummary(id: "bd50a1e2-img", shortID: "bd50", projectID: "inv", title: "Add stock report images", status: "completed",
                           summary: "I can't see the photo: only its file path came through, and you asked me not to use tools to open it. Please attach the image directly so I can name its colors.",
                           agent: .claudeCode, model: "Haiku 5.5", branch: "ch/bd50-add-stock-report-images", targetBranch: "main",
                           updatedAt: ago(minutes: 3)),
            SessionSummary(id: "c4534455-rw", shortID: "c453", projectID: "inv", title: "Reword README summary", status: "completed",
                           summary: "I replaced the README.md summary line with \"Tracks per-SKU stock levels for the warehouse API.\" The diff shows only that one line changed. I didn't commit or push anything.",
                           agent: .claudeCode, model: "Haiku 5.5", branch: "ch/c453-reword-readme-summary", targetBranch: "main",
                           updatedAt: ago(minutes: 3, seconds: 1)),
            SessionSummary(id: "7a3f5d10-add", shortID: "7a3f", projectID: "inv", title: "Add removeStock to stock module", status: "completed",
                           summary: "I applied two of the review’s findings to my worktree, \(worktree).",
                           agent: .claudeCode, model: "Haiku 5.5", branch: "ch/e7a6-add-removestock-to-stock", targetBranch: "main",
                           updatedAt: ago(minutes: 8)),
            SessionSummary(id: "b41c8e33-rev", shortID: "b41c", projectID: "inv", title: "Review removeStock in src/stock.ts for edge cases", status: "completed",
                           delegatedFromID: "7a3f5d10-add", summary: "Negative amount silently restocks the item.",
                           agent: .claudeCode, model: "Haiku 5.5", branch: "ch/e7a6-add-removestock-to-stock", targetBranch: "main",
                           updatedAt: ago(minutes: 8, seconds: 1)),
            SessionSummary(id: "4a53c7f9-sum", shortID: "4a53", projectID: "inv", title: "Summarize stock module", status: "failed",
                           agent: .claudeCode, model: "nonexistent-model-xyz", branch: "ch/4a53-summarize-stock-module", targetBranch: "main",
                           updatedAt: ago(minutes: 12)),
        ]
    }

    /// Sessions the user had already opened (the rest show the unread marker).
    static let viewedIDs: Set<String> = ["bd50a1e2-img", "7a3f5d10-add", "4a53c7f9-sum"]
    static let pinnedIDs: Set<String> = ["4a53c7f9-sum"]

    /// lib/agent-runtime-options.ts as of the capture.
    static let models: [ModelOption] = [
        ModelOption(label: "Fable 5.2", value: "fable", agent: .claudeCode, description: "Most capable model for demanding, long-horizon work.", efforts: Effort.lowToMax, supportsFastSpeed: true),
        ModelOption(label: "Opus 5.5", value: "opus", agent: .claudeCode, description: "Highly capable model for complex agentic coding.", efforts: Effort.lowToMax, supportsFastSpeed: true),
        ModelOption(label: "Sonnet 5.5", value: "sonnet", agent: .claudeCode, description: "Balanced model for everyday coding.", efforts: Effort.lowToMax, supportsFastSpeed: false),
        ModelOption(label: "Haiku 5.5", value: "haiku", agent: .claudeCode, description: "Fastest, most cost-efficient model.", efforts: Effort.lowToMax, supportsFastSpeed: false),
        ModelOption(label: "GPT-6.1 Sol", value: "gpt-6.1-sol", agent: .codex, description: "Latest workhorse model for coding and everyday work.", efforts: Effort.lowToUltra, supportsFastSpeed: false),
        ModelOption(label: "GPT-6 Astra", value: "gpt-6-astra", agent: .codex, description: "Frontier intelligence for the most demanding work.", efforts: Effort.lowToUltra, supportsFastSpeed: false),
        ModelOption(label: "GPT-6.1 Terra", value: "gpt-6.1-terra", agent: .codex, description: "Balanced model for straightforward work.", efforts: Effort.lowToUltra, supportsFastSpeed: false),
        ModelOption(label: "GPT-6 Sol", value: "gpt-6-sol", agent: .codex, description: "Previous generation workhorse model.", efforts: Effort.lowToUltra, supportsFastSpeed: false),
        ModelOption(label: "GPT-6 Luna", value: "gpt-6-luna", agent: .codex, description: "Fast and affordable model for easier tasks.", efforts: Effort.lowToMax, supportsFastSpeed: false),
        ModelOption(label: "GPT-5.6 Sol", value: "gpt-5.6-sol", agent: .codex, description: "Older generation workhorse model.", efforts: Effort.lowToUltra, supportsFastSpeed: false),
        ModelOption(label: "GPT-5.6 Terra", value: "gpt-5.6-terra", agent: .codex, description: "Older balanced model for straightforward work.", efforts: Effort.lowToUltra, supportsFastSpeed: false),
        ModelOption(label: "GPT-5.6 Luna", value: "gpt-5.6-luna", agent: .codex, description: "Older fast and efficient model.", efforts: Effort.lowToMax, supportsFastSpeed: false),
    ]

    static let skills = [SkillSummary(name: "chro", description: "Drive chro sessions with the `chro` CLI.", source: "~/.claude")]
    static let files = ["src/stock.ts", "src/stock.test.ts", "README.md"]

    /// GET /rpc/filesystem/directory listings seen in the second capture; other folders were not captured.
    static let pickerStart = "/private/tmp/mm/iso2/repo"
    static let listings: [String: DirectoryListing] = [
        "/private/tmp/mm/iso2/repo": DirectoryListing(path: "/private/tmp/mm/iso2/repo", isGitRepository: false, entries: [
            .init(name: "inventory-service", isDirectory: true, isGitRepository: true), .init(name: "pricing-notes", isDirectory: true),
        ]),
        "/private/tmp/mm/iso2/repo/inventory-service": DirectoryListing(path: "/private/tmp/mm/iso2/repo/inventory-service", isGitRepository: true, entries: [
            .init(name: "src", isDirectory: true), .init(name: "README.md", isDirectory: false),
        ]),
        "/private/tmp/mm/iso2/repo/pricing-notes": DirectoryListing(path: "/private/tmp/mm/iso2/repo/pricing-notes", isGitRepository: false, entries: [
            .init(name: "notes.md", isDirectory: false),
        ]),
    ]

    /// GET /rpc/executor/install-status on the two captured hosts. The server
    /// reports only the version number of `--version` (executors profile.rs
    /// extract_detected_version); the capture predates that and held the raw line.
    static let mainHostInstall = InstallStatus(git: .installed(version: "2.43.0"), agents: [
        .claudeCode: .installed(version: "2.1.323"), .codex: .installed(version: "0.162.1"), .pi: .installed(version: "0.81.1"),
    ])
    static let bareHostInstall = InstallStatus(git: .installed(version: "2.50.1"), agents: [
        .claudeCode: .notInstalled, .codex: .installed(version: "0.162.1"), .pi: .installed(version: nil),
    ])

    static let host = PairedHost(id: "host-1", name: "Host 1", endpoint: "ws://192.168.1.23:6768")
}
