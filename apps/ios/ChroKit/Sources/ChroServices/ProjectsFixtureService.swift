import ChroDomain
import Foundation

extension FixtureWorkspace: ProjectsService {
    public func projects() -> AsyncStream<ProjectsState> { projectState.stream() }

    public func openWorkspace(path: String) async throws -> ProjectSummary {
        let name = String(path.split(separator: "/").last ?? Substring(path))
        guard !name.isEmpty else { throw ServiceError.invalid("Choose a folder to open.") }
        let project: ProjectSummary = locked {
            // The second capture opened the first capture's repo again under a new path: one project.
            if let known = knownProjects.first(where: { $0.path == path || ($0.name == name && $0.id != MockCapture.general.id) }) { return known }
            let created = ProjectSummary(id: "p-\(UUID().uuidString.prefix(8).lowercased())", name: name, path: path,
                                         isGitRepository: MockCapture.listings[path]?.isGitRepository ?? false)
            knownProjects.append(created)
            return created
        }
        projectState.update { state in
            if !state.openProjects.contains(where: { $0.id == project.id }) { state.openProjects.append(project) }
            state.recents = Array(([project] + state.recents.filter { $0.id != project.id }).prefix(5))
        }
        return project
    }

    public func ensureScratchProject() async throws -> String {
        let general = MockCapture.general
        locked { if !knownProjects.contains(where: { $0.id == general.id }) { knownProjects.append(general) } }
        projectState.update { $0.scratchProjectIDs.insert(general.id) }
        return general.id
    }

    public func removeFromSidebar(projectID: String) async throws {
        projectState.update { $0.openProjects.removeAll { $0.id == projectID } }
    }

    public func setBadgeColor(projectID: String, color: String?) async throws {
        locked { if let index = knownProjects.firstIndex(where: { $0.id == projectID }) { knownProjects[index].badgeColor = color } }
        projectState.update { state in
            for index in state.openProjects.indices where state.openProjects[index].id == projectID { state.openProjects[index].badgeColor = color }
            for index in state.recents.indices where state.recents[index].id == projectID { state.recents[index].badgeColor = color }
        }
    }

    public func homeDirectory() async throws -> String { MockCapture.pickerStart }

    public func listDirectory(path: String) async throws -> DirectoryListing {
        guard let listing = MockCapture.listings[path] else {
            throw ServiceError.unavailable("Failed to load directory")
        }
        return listing
    }
}

extension FixtureWorkspace: OnboardingService {
    public func installStatus() async throws -> InstallStatus { locked { installStatus } }

    public func setDefaultAgent(_ agent: AgentKind) async throws { locked { defaultAgent = agent } }

    public func isOnboardingComplete() async throws -> Bool { locked { onboardingComplete } }

    public func completeOnboarding() async throws { locked { onboardingComplete = true } }
}
