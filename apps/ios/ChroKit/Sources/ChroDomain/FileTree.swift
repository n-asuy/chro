import Foundation

/// One file or folder of a checkout, by root-relative path.
public struct FileTreeEntry: Equatable, Hashable, Sendable {
    public var path: String
    public var isDirectory: Bool

    public init(path: String, isDirectory: Bool) {
        self.path = path
        self.isDirectory = isDirectory
    }

    public var name: String { path.split(separator: "/").last.map(String.init) ?? path }
}

/// The right dock's file tree (files/components/file-tree): folders before
/// files, then by name, children shown under expanded folders.
public struct FileTree: Equatable, Sendable {
    public struct Row: Equatable, Sendable, Identifiable {
        public var entry: FileTreeEntry
        /// 1 for the root's children.
        public var depth: Int
        public var isExpanded: Bool

        public var path: String { entry.path }
        public var name: String { entry.name }
        public var isDirectory: Bool { entry.isDirectory }
        public var id: String { entry.path }
    }

    public var entries: [FileTreeEntry]

    public init(entries: [FileTreeEntry]) { self.entries = entries }

    /// Only what a run changed, with the folders those paths need
    /// (lib/changed-files-tree.ts).
    public static func changed(paths: [String]) -> FileTree {
        var seen = Set<String>()
        var entries: [FileTreeEntry] = []
        for raw in paths {
            let path = String(raw.replacingOccurrences(of: "\\", with: "/").drop { $0 == "/" })
            guard !path.isEmpty, !seen.contains(path) else { continue }
            for folder in ancestors(of: path) where !seen.contains(folder) {
                seen.insert(folder)
                entries.append(FileTreeEntry(path: folder, isDirectory: true))
            }
            seen.insert(path)
            entries.append(FileTreeEntry(path: path, isDirectory: false))
        }
        return FileTree(entries: entries)
    }

    /// The server's listing rule while hidden entries are off: folders whose
    /// name starts with a dot are left out with everything under them; dot
    /// files stay (filesystem `is_hidden`, applied to directories only).
    public func hidingHiddenDirectories() -> FileTree {
        let hidden = entries.filter { $0.isDirectory && $0.name.hasPrefix(".") }.map(\.path)
        return FileTree(entries: entries.filter { entry in
            !hidden.contains { entry.path == $0 || entry.path.hasPrefix($0 + "/") }
        })
    }

    public var directories: [String] { entries.filter(\.isDirectory).map(\.path) }

    public func rows(expanded: Set<String>) -> [Row] { rows { expanded.contains($0) } }

    public func rows(expandAll: Bool) -> [Row] { rows { _ in expandAll } }

    private func rows(isExpanded: (String) -> Bool) -> [Row] {
        var children: [String: [FileTreeEntry]] = [:]
        for entry in entries { children[Self.parent(of: entry.path), default: []].append(entry) }
        for key in children.keys { children[key]?.sort(by: Self.order) }
        var rows: [Row] = []
        func walk(_ folder: String, depth: Int) {
            for entry in children[folder] ?? [] {
                let open = entry.isDirectory && isExpanded(entry.path)
                rows.append(Row(entry: entry, depth: depth, isExpanded: open))
                if open { walk(entry.path, depth: depth + 1) }
            }
        }
        walk("", depth: 1)
        return rows
    }

    static func order(_ a: FileTreeEntry, _ b: FileTreeEntry) -> Bool {
        if a.isDirectory != b.isDirectory { return a.isDirectory }
        return a.path.localizedCompare(b.path) == .orderedAscending
    }

    /// The containing folder, `""` at the root.
    public static func parent(of path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[..<slash])
    }

    /// Every containing folder, outermost first.
    public static func ancestors(of path: String) -> [String] {
        let segments = path.split(separator: "/")
        return segments.indices.dropFirst().map { segments[..<$0].joined(separator: "/") }
    }
}
