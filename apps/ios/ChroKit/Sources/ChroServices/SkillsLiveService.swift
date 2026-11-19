import ChroDomain
import Foundation

/// SkillsService over the paired desktop (lib/skill-client.ts `listSkills`, lib/preferences-client.ts).
final class SkillsLiveService: SkillsService, @unchecked Sendable {
    private let calls: PanelLiveCalls

    init(calls: PanelLiveCalls) { self.calls = calls }

    func skills(workspacePath: String?) async throws -> [SkillPackage] {
        var query: [String: String] = [:]
        if let path = workspacePath?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty { query["workspace_path"] = path }
        let wire = try calls.decode(Envelope.self, try await calls.body(.get, ["rpc", "skills"], query: query))
        // A source this build does not know is left out rather than mislabelled.
        return wire.skills.compactMap { skill in
            guard let source = SkillSource(rawValue: skill.source) else { return nil }
            return SkillPackage(id: skill.id, name: skill.name, description: skill.description, source: source,
                                sourcePath: skill.sourcePath, baseDir: skill.baseDir, absDir: skill.absDir)
        }
    }

    func showsHiddenEntries() async throws -> Bool {
        try await SettingsLiveService.fetchPreferences(calls).showHiddenEntries
    }

    private struct Envelope: Decodable {
        struct Skill: Decodable {
            let id: String
            let name: String
            let description: String
            let source: String
            let sourcePath: String
            let baseDir: String
            let absDir: String

            enum CodingKeys: String, CodingKey {
                case id, name, description, source, sourcePath = "source_path", baseDir = "base_dir", absDir = "abs_dir"
            }
        }

        let skills: [Skill]
    }
}
