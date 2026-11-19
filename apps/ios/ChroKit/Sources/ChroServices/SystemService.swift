import ChroDomain
import Foundation

/// `/rpc/cli-status`: chro's server and the agent CLIs on the desktop's PATH.
public struct CliStatus: Equatable, Sendable {
    public struct Agent: Equatable, Sendable, Identifiable {
        /// The manifest name, e.g. `claude`.
        public var name: String
        public var found: Bool
        public var path: String?
        public var source: String?
        public var version: String?
        public var installHint: String
        public var id: String { name }

        public init(name: String, found: Bool, path: String?, source: String?, version: String?, installHint: String) {
            self.name = name
            self.found = found
            self.path = path
            self.source = source
            self.version = version
            self.installHint = installHint
        }
    }

    public var agents: [Agent]
    public var serverVersion: String
    public var latestRelease: String?
    public var updateAvailable: Bool

    public init(agents: [Agent], serverVersion: String, latestRelease: String?, updateAvailable: Bool) {
        self.agents = agents
        self.serverVersion = serverVersion
        self.latestRelease = latestRelease
        self.updateAvailable = updateAvailable
    }
}

/// `/rpc/agent-usage`: one agent CLI's token usage over a rolling window, read by
/// the desktop from the CLI's local session logs (crates/server routes/rpc/usage.rs).
public struct AgentUsage: Equatable, Sendable {
    public struct Tokens: Equatable, Sendable {
        /// Fresh (non-cached) prompt tokens.
        public var input: Int
        public var output: Int
        /// Prompt tokens served from cache.
        public var cacheRead: Int
        public var cacheCreation: Int
        public var total: Int

        public init(input: Int, output: Int, cacheRead: Int, cacheCreation: Int, total: Int) {
            self.input = input
            self.output = output
            self.cacheRead = cacheRead
            self.cacheCreation = cacheCreation
            self.total = total
        }
    }

    /// The `cli-status` manifest name, e.g. `claude`.
    public var provider: String
    /// `status == "ok"`: logs were found and scanned (`unavailable` otherwise).
    public var isAvailable: Bool
    public var windowMinutes: Int
    public var tokens: Tokens
    /// Only for CLIs that record their spend.
    public var costUSD: Double?
    public var sessionCount: Int

    public init(provider: String, isAvailable: Bool, windowMinutes: Int, tokens: Tokens, costUSD: Double?, sessionCount: Int) {
        self.provider = provider
        self.isAvailable = isAvailable
        self.windowMinutes = windowMinutes
        self.tokens = tokens
        self.costUSD = costUSD
        self.sessionCount = sessionCount
    }
}

/// The Agent status row's usage meter (agent-status-menu.tsx `UsageMeter`):
/// absent without a report, for an unavailable one, and for a window without
/// tokens. The bar shows fresh against cached prompt tokens, not a limit.
public struct UsageMeter: Equatable, Sendable {
    public let windowLabel: String
    /// The window's total tokens, formatted.
    public let total: String
    /// `round(cache_read / total * 100)`.
    public let cachedPercent: Int
    /// `{output} out · {cached}% cached · {n} session(s)[ · {cost}]`.
    public let summary: String

    public init?(_ usage: AgentUsage?) {
        guard let usage, usage.isAvailable, usage.tokens.total != 0 else { return nil }
        let tokens = usage.tokens
        windowLabel = Self.windowLabel(minutes: usage.windowMinutes)
        total = Self.tokens(tokens.total)
        cachedPercent = Int((Double(tokens.cacheRead) / Double(tokens.total) * 100).rounded(.toNearestOrAwayFromZero))
        summary = "\(Self.tokens(tokens.output)) out · \(cachedPercent)% cached · \(usage.sessionCount) session\(usage.sessionCount == 1 ? "" : "s")"
            + (usage.costUSD.map { " · \(Self.cost($0))" } ?? "")
    }

    /// `usageWindowLabel`.
    static func windowLabel(minutes: Int) -> String { minutes % 60 == 0 ? "\(minutes / 60)h" : "\(minutes)m" }

    /// `formatTokens`.
    static func tokens(_ count: Int) -> String {
        let value = Double(count)
        if count >= 1_000_000_000 { return "\(fixed(value / 1_000_000_000, 1))B" }
        if count >= 1_000_000 { return "\(fixed(value / 1_000_000, 1))M" }
        if count >= 1_000 { return "\(fixed(value / 1_000, 1))k" }
        return "\(count)"
    }

    /// `formatCost`.
    static func cost(_ usd: Double) -> String { usd < 0.01 ? "<$0.01" : "$\(fixed(usd, 2))" }

    /// `Number.prototype.toFixed` for non-negative values: halves round up.
    private static func fixed(_ value: Double, _ digits: Int) -> String {
        let scale = pow(10, Double(digits))
        return String(format: "%.\(digits)f", (value * scale).rounded(.toNearestOrAwayFromZero) / scale)
    }
}

/// The feedback menu's categories (feedback/feedback-api.ts).
public enum FeedbackCategory: String, Sendable, CaseIterable {
    case feedback, bug, feature
}

/// Agent status and feedback.
public protocol SystemService: Sendable {
    /// GET /rpc/cli-status.
    func cliStatus() async throws -> CliStatus
    /// GET /rpc/agent-usage (slower; loaded beside the status, never blocking it).
    func agentUsage() async throws -> [AgentUsage]
    /// POST <cloud API>/feedback; throws with the response text when refused.
    func submitFeedback(category: FeedbackCategory, message: String) async throws
}

/// Sends feedback to the cloud API the desktop posts to (`apps/api`), not
/// through the paired desktop. The live SystemService uses it.
public struct CloudFeedbackSender: Sendable {
    public static let endpoint = URL(string: "https://api.chro-ai.com/feedback")!

    public var endpoint: URL
    public var appVersion: String?
    public var session: URLSession

    public init(endpoint: URL = CloudFeedbackSender.endpoint, appVersion: String?, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.appVersion = appVersion
        self.session = session
    }

    public struct Failure: Error, Equatable, LocalizedError {
        public var message: String
        public var errorDescription: String? { message }
    }

    public func send(category: FeedbackCategory, message: String) async throws {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = ["category": category.rawValue, "message": message, "platform": "ios"]
        if let appVersion { body["appVersion"] = appVersion }
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw Failure(message: text.isEmpty ? "Feedback request failed with status \(status)" : text)
        }
    }
}
