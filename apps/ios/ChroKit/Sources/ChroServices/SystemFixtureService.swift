import ChroDomain
import Foundation

/// SystemService with the mock's captured Agent status. Feedback is kept in
/// memory and never leaves the phone.
final class SystemFixtureService: SystemService, @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [(FeedbackCategory, String)] = []
    private var probes = 0

    /// Every scenario shares the captured CLI status.
    init(scenario: FixtureScenario) {}

    /// The captured status; probes after the first find the next release published.
    func cliStatus() async throws -> CliStatus {
        try await Task.sleep(for: .milliseconds(300))
        let probe = lock.withLock { () -> Int in
            probes += 1
            return probes
        }
        return probe == 1 ? Self.captured : Self.afterRelease
    }

    func agentUsage() async throws -> [AgentUsage] {
        try await Task.sleep(for: .milliseconds(300))
        return Self.usage
    }

    func submitFeedback(category: FeedbackCategory, message: String) async throws {
        try await Task.sleep(for: .milliseconds(500))
        lock.withLock { sent.append((category, message)) }
    }

    /// GET /rpc/cli-status as the Agent status menu showed it.
    static let captured = CliStatus(
        agents: [
            CliStatus.Agent(name: "claude", found: true, path: "/Users/me/.local/bin/claude", source: "~/.local/bin/claude",
                            version: "2.1.323 (Claude Code)", installHint: ""),
            CliStatus.Agent(name: "codex", found: true, path: "/opt/homebrew/bin/codex", source: "/opt/homebrew/bin/codex",
                            version: "codex-cli 0.162.1", installHint: ""),
            CliStatus.Agent(name: "pi", found: true, path: "/opt/homebrew/bin/pi", source: "/opt/homebrew/bin/pi",
                            version: "0.81.1", installHint: ""),
        ],
        serverVersion: "0.1.57", latestRelease: "v0.1.57", updateAvailable: false
    )

    /// The same desktop once v0.1.58 is out.
    static var afterRelease: CliStatus {
        var status = captured
        status.latestRelease = "v0.1.58"
        status.updateAvailable = true
        return status
    }

    /// GET /rpc/agent-usage: Claude Code used in the window, Codex without local
    /// logs, pi with logs but unused (the last two show no meter).
    static let usage = [
        AgentUsage(provider: "claude", isAvailable: true, windowMinutes: 300,
                   tokens: .init(input: 120_000, output: 45_000, cacheRead: 1_000_000, cacheCreation: 35_000, total: 1_200_000),
                   costUSD: 1.234, sessionCount: 3),
        AgentUsage(provider: "codex", isAvailable: false, windowMinutes: 300,
                   tokens: .init(input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0), costUSD: nil, sessionCount: 0),
        AgentUsage(provider: "pi", isAvailable: true, windowMinutes: 300,
                   tokens: .init(input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0), costUSD: nil, sessionCount: 0),
    ]
}
