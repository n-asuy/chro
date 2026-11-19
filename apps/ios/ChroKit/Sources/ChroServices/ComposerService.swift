import ChroDomain
import Foundation

/// A skill the composer's `/` and Skills picker offer.
public struct SkillSummary: Equatable, Sendable, Identifiable, Hashable {
    public var name: String
    public var description: String
    /// Where it is installed, e.g. `~/.claude`.
    public var source: String
    public var id: String { name }

    public init(name: String, description: String, source: String) {
        self.name = name
        self.description = description
        self.source = source
    }
}

/// A branch the "From" sheet offers.
public struct BranchOption: Equatable, Sendable, Identifiable, Hashable {
    public var name: String
    public var isCurrent: Bool
    public var id: String { name }

    public init(name: String, isCurrent: Bool = false) {
        self.name = name
        self.isCurrent = isCurrent
    }
}

/// What the composer needs besides the sessions themselves: the model
/// catalogue, the default runtime, branches for "From", and the context
/// sources of the + sheet. The conversation screen reuses the same service
/// for its own composer.
public protocol ComposerService: Sendable {
    func models() async throws -> [ModelOption]
    /// The runtime a new session starts with (Settings → default agent).
    func defaultRuntime() async throws -> RuntimeChoice
    func branches(projectID: String) async throws -> [BranchOption]
    func skills(projectID: String) async throws -> [SkillSummary]
    /// Workspace-relative file paths matching `query` (all files, capped by the caller, when empty).
    func files(projectID: String, query: String) async throws -> [String]
}
