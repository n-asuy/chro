import ChroDomain
import Foundation

/// SystemService over the paired desktop: `/rpc/cli-status`
/// (lib/cli-status-client.ts). Feedback goes where the desktop sends it
/// (feedback/feedback-api.ts): the cloud API, not the paired desktop.
final class SystemLiveService: SystemService, @unchecked Sendable {
    private let calls: PanelLiveCalls
    private let feedback: CloudFeedbackSender

    init(calls: PanelLiveCalls, feedback: CloudFeedbackSender) {
        self.calls = calls
        self.feedback = feedback
    }

    func cliStatus() async throws -> CliStatus {
        let wire = try calls.decode(Wire.self, try await calls.body(.get, ["rpc", "cli-status"]))
        return CliStatus(
            agents: wire.agents.map {
                CliStatus.Agent(name: $0.name, found: $0.found, path: $0.path, source: $0.source, version: $0.version, installHint: $0.installHint)
            },
            serverVersion: wire.serverVersion, latestRelease: wire.latestRelease, updateAvailable: wire.updateAvailable
        )
    }

    func agentUsage() async throws -> [AgentUsage] {
        try calls.decode(UsageWire.self, try await calls.body(.get, ["rpc", "agent-usage"])).providers.map {
            AgentUsage(provider: $0.provider, isAvailable: $0.status == "ok", windowMinutes: $0.windowMinutes,
                       tokens: .init(input: $0.tokens.input, output: $0.tokens.output, cacheRead: $0.tokens.cacheRead,
                                     cacheCreation: $0.tokens.cacheCreation, total: $0.tokens.total),
                       costUSD: $0.costUsd, sessionCount: $0.sessionCount)
        }
    }

    func submitFeedback(category: FeedbackCategory, message: String) async throws {
        try await feedback.send(category: category, message: message)
    }

    /// `AgentUsageResponse` (usage.rs).
    private struct UsageWire: Decodable {
        struct Provider: Decodable {
            struct Tokens: Decodable {
                let input: Int
                let output: Int
                let cacheRead: Int
                let cacheCreation: Int
                let total: Int

                enum CodingKeys: String, CodingKey { case input, output, total, cacheRead = "cache_read", cacheCreation = "cache_creation" }
            }

            let provider: String
            let status: String
            let windowMinutes: Int
            let tokens: Tokens
            let costUsd: Double?
            let sessionCount: Int

            enum CodingKeys: String, CodingKey {
                case provider, status, tokens, windowMinutes = "window_minutes", costUsd = "cost_usd", sessionCount = "session_count"
            }
        }

        let providers: [Provider]
    }

    /// `CliStatusResponse`.
    private struct Wire: Decodable {
        struct Agent: Decodable {
            let name: String
            let found: Bool
            let path: String?
            let source: String?
            let version: String?
            let installHint: String

            enum CodingKeys: String, CodingKey { case name, found, path, source, version, installHint = "install_hint" }
        }

        let agents: [Agent]
        let serverVersion: String
        let latestRelease: String?
        let updateAvailable: Bool

        enum CodingKeys: String, CodingKey {
            case agents, serverVersion = "server_version", latestRelease = "latest_release", updateAvailable = "update_available"
        }
    }
}
