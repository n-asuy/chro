import ChroAPI
import ChroDomain
import ChroLink
import Foundation

extension LiveWorkspace {
    /// The Claude and Codex presets of lib/agent-runtime-options.ts (the desktop
    /// keeps them in code, not on the server). pi's models come from the server.
    static let staticModels: [ModelOption] = [
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

    /// `GET /rpc/skills` entries (skills crate `SkillSummary`).
    struct SkillRow: Decodable, Sendable {
        let id: String
        let name: String
        let description: String
        let source: String

        /// skillSourceLabel of lib/skill-client.ts.
        var sourceLabel: String {
            switch source {
            case "workspace_claude": ".claude"
            case "workspace_agents": ".agents"
            case "workspace_chro": "workspace"
            case "user_claude": "~/.claude"
            case "user_agents": "~/.agents"
            case "user_codex": "~/.codex"
            default: source
            }
        }
    }

    private struct SkillList: Decodable { let skills: [SkillRow] }

    /// The skills the desktop finds for the project's folder.
    func skillRows(projectID: String) async throws -> [SkillRow] {
        let project = try await projectRow(projectID)
        return try await json(SkillList.self, RawRequest(path: "/rpc/skills", query: ["workspace_path": project.gitRepoPath])).skills
    }

    /// The `@` picker's default suggestions (at-popover.tsx `DEFAULT_FILE_SUGGESTIONS`).
    static let defaultFileSuggestions = 5
}

extension LiveWorkspace: ComposerService {
    private struct PiModel: Decodable {
        let value: String
        let label: String
        let provider: String?
    }

    public func models() async throws -> [ModelOption] {
        let pi = (try? await json([PiModel].self, RawRequest(path: "/rpc/executor/pi/models"))) ?? []
        return Self.staticModels + pi.map {
            ModelOption(label: $0.label, value: $0.value, agent: .pi, description: $0.provider ?? "", efforts: [], supportsFastSpeed: false)
        }
    }

    /// Settings → default agent: `GET /rpc/executor/profile`, the model shown by its label.
    public func defaultRuntime() async throws -> RuntimeChoice {
        let profile = try await json(ProfileEnvelope.self, RawRequest(path: "/rpc/executor/profile")).profile
        guard let agent = AgentKind(rawValue: profile.executor) else { throw ServiceError.unavailable("Unexpected response from the desktop (/rpc/executor/profile).") }
        var label = profile.model
        if let value = profile.model {
            label = Self.staticModels.first { $0.agent == agent && $0.value == value }?.label ?? value
        }
        return RuntimeChoice(
            agent: agent,
            model: label,
            effort: profile.reasoningEffort.flatMap(Effort.init(rawValue:)),
            speed: profile.speed.flatMap(Speed.init(rawValue:))
        )
    }

    private struct BranchList: Decodable {
        struct Branch: Decodable {
            let name: String
            let isCurrent: Bool
            let isRemote: Bool
        }

        let branches: [Branch]
    }

    /// Local branches, the checked-out one first (use-session-execution-options.ts).
    public func branches(projectID: String) async throws -> [BranchOption] {
        let list = try await json(BranchList.self, RawRequest(path: RawRequest.path("rpc", "projects", projectID, "git", "branches")))
        let local = list.branches.filter { !$0.isRemote }
        let ordered = local.filter(\.isCurrent) + local.filter { !$0.isCurrent }
        return ordered.map { BranchOption(name: $0.name, isCurrent: $0.isCurrent) }
    }

    public func skills(projectID: String) async throws -> [SkillSummary] {
        try await skillRows(projectID: projectID).map { SkillSummary(name: $0.name, description: $0.description, source: $0.sourceLabel) }
    }

    private struct SearchResults: Decodable {
        struct Result: Decodable {
            let path: String
            let isFile: Bool
        }

        let results: [Result]
    }

    /// `GET /rpc/projects/:id/search`: a name search for the query, or the
    /// repository's most relevant files when it is empty (project-client.ts).
    public func files(projectID: String, query: String) async throws -> [String] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        var parameters = ["q": needle]
        if needle.isEmpty {
            parameters["files_only"] = "true"
            parameters["limit"] = String(Self.defaultFileSuggestions)
        }
        let response = try await json(SearchResults.self, RawRequest(path: RawRequest.path("rpc", "projects", projectID, "search"), query: parameters))
        return response.results.filter(\.isFile).map(\.path)
    }
}

extension LiveWorkspace: OnboardingService {
    /// The desktop's "setup finished" flag (onboarding/use-onboarding.ts).
    static let onboardingCompleteKey = "chro:setup-onboarding-complete"

    private struct InstallStatusResponse: Decodable {
        struct Executable: Decodable {
            let installed: Bool
            let detectedVersion: String?
        }

        let claudeCode: Executable
        let codex: Executable
        let pi: Executable
        let git: Executable
    }

    public func installStatus() async throws -> InstallStatus {
        let status = try await json(InstallStatusResponse.self, RawRequest(path: "/rpc/executor/install-status"))
        func detection(_ executable: InstallStatusResponse.Executable) -> InstallStatus.Detection {
            executable.installed ? .installed(version: executable.detectedVersion) : .notInstalled
        }
        return InstallStatus(git: detection(status.git), agents: [
            .claudeCode: detection(status.claudeCode), .codex: detection(status.codex), .pi: detection(status.pi),
        ])
    }

    private struct ProfileUpdate: Encodable {
        let executor: String
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(executor, forKey: .executor)
            try container.encodeNil(forKey: .variant)  // null resets the variant, as onboarding-flow.tsx sends
        }

        enum CodingKeys: String, CodingKey { case executor, variant }
    }

    public func setDefaultAgent(_ agent: AgentKind) async throws {
        _ = try Self.successBody(try await send(RawRequest(method: .put, path: "/rpc/executor/profile", body: Self.body(ProfileUpdate(executor: agent.rawValue)))))
        locked { profileAgent = agent }
        publishSessions()
    }

    /// Read fresh from the desktop each time the app checks a newly active host.
    public func isOnboardingComplete() async throws -> Bool {
        let state = try await fetchUIState()
        replaceUIState(state)
        return state[Self.onboardingCompleteKey] == .bool(true)
    }

    public func completeOnboarding() async throws {
        try await writeUIState([Self.onboardingCompleteKey: .bool(true)])
    }
}
