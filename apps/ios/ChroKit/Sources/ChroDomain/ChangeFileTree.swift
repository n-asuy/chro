import Foundation

/// change-file-list.tsx: changed files as a flat list or nested under their
/// folders (folders first, names in locale order, single-child folder chains
/// folded into one `a/b/c` row keyed by the deepest folder), paged 300 at a time.
public enum ChangeFileTree {
    public enum Mode: String, Sendable { case list, tree }

    public enum Row: Equatable, Sendable, Identifiable {
        case directory(key: String, name: String, depth: Int, isCollapsed: Bool)
        case file(path: String, depth: Int)

        public var id: String {
            switch self {
            case .directory(let key, _, _, _): return "dir:" + key
            case .file(let path, _): return "file:" + path
            }
        }
    }

    public static let pageSize = 300

    public static func visibleCount(total: Int, pages: Int) -> Int { min(total, pageSize * max(1, pages)) }

    /// "Show N more (M remaining)", or nil when everything is visible.
    public static func moreLabel(total: Int, visible: Int) -> String? {
        let remaining = total - visible
        guard remaining > 0 else { return nil }
        return "Show \(min(remaining, pageSize)) more (\(remaining) remaining)"
    }

    /// The row's label: the last path segment.
    public static func fileName(_ path: String) -> String {
        if path.trimmingCharacters(in: .whitespaces).isEmpty { return "(unknown)" }
        if path.hasSuffix("/") { return path }
        return path.split(separator: "/").last.map(String.init) ?? path
    }

    public static func rows(paths: [String], mode: Mode, collapsed: Set<String>) -> [Row] {
        switch mode {
        case .list:
            return paths.map { .file(path: $0, depth: 0) }
        case .tree:
            var rows: [Row] = []
            append(compact(build(paths)), depth: 0, collapsed: collapsed, into: &rows)
            return rows
        }
    }

    private final class Node {
        let key: String
        let name: String
        let filePath: String?
        var children: [Node] = []
        init(key: String, name: String, filePath: String?) {
            self.key = key
            self.name = name
            self.filePath = filePath
        }
        var isDirectory: Bool { filePath == nil }
    }

    private static func build(_ paths: [String]) -> [Node] {
        let root = Node(key: "", name: "", filePath: nil)
        for path in paths {
            var segments = path.split(separator: "/").map(String.init)
            if segments.isEmpty { segments = [path.isEmpty ? "(unknown)" : path] }
            var current = root
            for (index, segment) in segments.enumerated() {
                if index == segments.count - 1 {
                    current.children.append(Node(key: path, name: segment, filePath: path))
                    continue
                }
                let key = current.key.isEmpty ? segment : current.key + "/" + segment
                if let next = current.children.first(where: { $0.isDirectory && $0.name == segment }) {
                    current = next
                } else {
                    let next = Node(key: key, name: segment, filePath: nil)
                    current.children.append(next)
                    current = next
                }
            }
        }
        sort(root)
        return root.children
    }

    private static func sort(_ node: Node) {
        node.children.sort { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory }
            let left = a.filePath ?? a.name, right = b.filePath ?? b.name
            return left.localizedStandardCompare(right) == .orderedAscending
        }
        node.children.filter(\.isDirectory).forEach(sort)
    }

    private static func compact(_ nodes: [Node]) -> [Node] {
        nodes.map { node in
            guard node.isDirectory else { return node }
            var name = node.name, key = node.key, children = node.children
            while children.count == 1, let only = children.first, only.isDirectory {
                name += "/" + only.name
                key = only.key
                children = only.children
            }
            let folded = Node(key: key, name: name, filePath: nil)
            folded.children = compact(children)
            return folded
        }
    }

    private static func append(_ nodes: [Node], depth: Int, collapsed: Set<String>, into rows: inout [Row]) {
        for node in nodes {
            if let path = node.filePath {
                rows.append(.file(path: path, depth: depth))
            } else {
                let isCollapsed = collapsed.contains(node.key)
                rows.append(.directory(key: node.key, name: node.name, depth: depth, isCollapsed: isCollapsed))
                if !isCollapsed { append(node.children, depth: depth + 1, collapsed: collapsed, into: &rows) }
            }
        }
    }
}
