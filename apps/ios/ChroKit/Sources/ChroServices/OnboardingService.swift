import ChroDomain
import Foundation

/// GET /rpc/executor/install-status: what the desktop found on its PATH.
public struct InstallStatus: Equatable, Sendable {
    public enum Detection: Equatable, Sendable {
        case notInstalled
        /// Found; the version string the CLI reported when it could be read.
        case installed(version: String?)

        public var isInstalled: Bool { if case .installed = self { true } else { false } }
    }

    public var git: Detection
    public var agents: [AgentKind: Detection]

    public init(git: Detection, agents: [AgentKind: Detection]) {
        self.git = git
        self.agents = agents
    }

    public func agent(_ kind: AgentKind) -> Detection { agents[kind] ?? .notInstalled }
}

/// The desktop's first-run setup, driven from the phone: detection, the
/// default agent, and the completion flag shared with the desktop.
public protocol OnboardingService: Sendable {
    func installStatus() async throws -> InstallStatus
    /// PUT /rpc/executor/profile: the agent new sessions start with.
    func setDefaultAgent(_ agent: AgentKind) async throws
    func isOnboardingComplete() async throws -> Bool
    func completeOnboarding() async throws
}

/// The upstream install guide each missing agent links to (lib/executor-install.ts).
public enum AgentInstallGuide {
    public static func url(for agent: AgentKind) -> URL {
        switch agent {
        case .claudeCode: return URL(string: "https://docs.anthropic.com/en/docs/claude-code/overview")!
        case .codex: return URL(string: "https://developers.openai.com/codex")!
        case .pi: return URL(string: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent")!
        }
    }
}
