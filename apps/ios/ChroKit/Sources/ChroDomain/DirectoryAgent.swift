import Foundation

/// How a finished session addressed to a directory ended (directory_map.rs).
public enum LedgerOutcome: String, CaseIterable, Sendable {
    case merged, completed, failed, archived

    /// A session's status and whether its merge stands; nil while it is pending or running.
    public init?(status: String, merged: Bool) {
        switch status {
        case "completed": self = merged ? .merged : .completed
        case "failed": self = merged ? .merged : .failed
        case "cancelled": self = merged ? .merged : .archived
        default: return nil
        }
    }

    public var label: String {
        switch self {
        case .merged: return "Merged"
        case .completed: return "Completed"
        case .failed: return "Failed"
        case .archived: return "Archived"
        }
    }
}

/// The standing-instruction file of a directory (directory_map.rs).
public enum DirectoryBrief {
    /// File names in precedence order.
    public static let fileNames = ["AGENTS.md", "CLAUDE.md"]

    /// The brief inside `directory` (`""` is the root) among the checkout's `files`.
    public static func find(in directory: String, files: Set<String>) -> String? {
        fileNames.lazy.map { directory.isEmpty ? $0 : "\(directory)/\($0)" }.first { files.contains($0) }
    }

    /// The nearest ancestor's brief; nil at the root.
    public static func inherited(by directory: String, files: Set<String>) -> String? {
        var segments = directory.split(separator: "/").map(String.init)
        while !segments.isEmpty {
            segments.removeLast()
            if let found = find(in: segments.joined(separator: "/"), files: files) { return found }
        }
        return nil
    }

    /// The panel's breadcrumb: the project, then each path segment.
    public static func crumbs(projectName: String, path: String) -> [String] {
        [projectName] + path.split(separator: "/").map(String.init)
    }
}
