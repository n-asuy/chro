import ChroAPI
import ChroDomain
import ChroLink
import Foundation

/// The fixture's desktop applying every change and losing its answer (the
/// desktop's `deadline_exceeded`, or the connection dropping before the reply):
/// reads pass through, a change takes effect and then throws `outcomeUnknown`.
/// Simulator checks of how the screens recover (`-ChroLoseAnswers`).
enum LostAnswer {
    static var error: ServiceError { .outcomeUnknown(LinkError.timeout.errorDescription ?? "") }

    static func applied<T>(_ change: () async throws -> T) async throws -> T {
        _ = try await change()
        throw error
    }
}

struct LostAnswerSourceControl: SourceControlService {
    let base: any SourceControlService

    func status(_ scope: CheckoutScope) async throws -> GitStatusSnapshot { try await base.status(scope) }
    func changes(_ scope: CheckoutScope, base ref: String?) async throws -> [FileChange] { try await base.changes(scope, base: ref) }
    func stage(_ scope: CheckoutScope, paths: [String]) async throws -> GitStatusSnapshot { try await LostAnswer.applied { try await base.stage(scope, paths: paths) } }
    func unstage(_ scope: CheckoutScope, paths: [String]) async throws -> GitStatusSnapshot { try await LostAnswer.applied { try await base.unstage(scope, paths: paths) } }
    func commit(_ scope: CheckoutScope, message: String) async throws { try await LostAnswer.applied { try await base.commit(scope, message: message) } }
    func push(_ scope: CheckoutScope) async throws -> GitStatusSnapshot { try await LostAnswer.applied { try await base.push(scope) } }
    func pull(_ scope: CheckoutScope) async throws -> GitStatusSnapshot { try await LostAnswer.applied { try await base.pull(scope) } }
    func discardAll(_ scope: CheckoutScope) async throws -> GitStatusSnapshot { try await LostAnswer.applied { try await base.discardAll(scope) } }
    func discard(_ scope: CheckoutScope, paths: [String]) async throws -> GitStatusSnapshot { try await LostAnswer.applied { try await base.discard(scope, paths: paths) } }
    func branchStatus(sessionID: String) async throws -> BranchStatus { try await base.branchStatus(sessionID: sessionID) }
    func rebase(sessionID: String, onto ref: String) async throws { try await LostAnswer.applied { try await base.rebase(sessionID: sessionID, onto: ref) } }
    func merge(sessionID: String) async throws { try await LostAnswer.applied { try await base.merge(sessionID: sessionID) } }
    func abortConflicts(sessionID: String) async throws { try await LostAnswer.applied { try await base.abortConflicts(sessionID: sessionID) } }
    func runDiff(sessionID: String) async throws -> [FileChange] { try await base.runDiff(sessionID: sessionID) }
    func fileData(_ scope: CheckoutScope, path: String) async throws -> Data { try await base.fileData(scope, path: path) }
    func updates(_ scope: CheckoutScope) -> AsyncStream<Void> { base.updates(scope) }
}

struct LostAnswerSettings: SettingsService {
    let base: any SettingsService

    func preferences() async throws -> SharedPreferences { try await base.preferences() }
    func savePreferences(_ preferences: SharedPreferences) async throws -> SharedPreferences { try await LostAnswer.applied { try await base.savePreferences(preferences) } }
    func mergeTemplate() async throws -> String { try await base.mergeTemplate() }
    func saveMergeTemplate(_ stored: String?) async throws -> String { try await LostAnswer.applied { try await base.saveMergeTemplate(stored) } }
    func editorLineHeight() async throws -> Double { try await base.editorLineHeight() }
    func saveEditorLineHeight(_ value: Double) async throws -> Double { try await LostAnswer.applied { try await base.saveEditorLineHeight(value) } }
    func accent() async throws -> String? { try await base.accent() }
    func saveAccent(_ hex: String?) async throws -> String? { try await LostAnswer.applied { try await base.saveAccent(hex) } }
    func nestDelegations() async throws -> Bool { try await base.nestDelegations() }
    func setNestDelegations(_ on: Bool) async throws { try await LostAnswer.applied { try await base.setNestDelegations(on) } }
    func defaultAgent() async throws -> AgentKind { try await base.defaultAgent() }
    func setDefaultAgent(_ agent: AgentKind) async throws { try await LostAnswer.applied { try await base.setDefaultAgent(agent) } }
    func mcpConfig(for agent: AgentKind) async throws -> McpConfigFile { try await base.mcpConfig(for: agent) }
    func saveMcpServers(_ servers: JSONValue, for agent: AgentKind) async throws -> McpConfigFile { try await LostAnswer.applied { try await base.saveMcpServers(servers, for: agent) } }
    func mcpStatus(for agent: AgentKind) async throws -> McpStatus { try await base.mcpStatus(for: agent) }
}
