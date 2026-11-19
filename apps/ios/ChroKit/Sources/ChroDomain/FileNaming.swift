import Foundation

/// What "New file" creates (files/types/file-tree.ts `NewFileKind`), plus a folder.
public enum NewEntryKind: String, CaseIterable, Sendable {
    case markdown = "md"
    case drawing = "excalidraw"
    case database = "cbase"
    case folder

    /// The file kinds the New file sheet lists, in order.
    public static let fileKinds: [NewEntryKind] = [.markdown, .drawing, .database]

    /// The New file sheet's row label.
    public var label: String {
        switch self {
        case .markdown: return "Markdown"
        case .drawing: return "Excalidraw"
        case .database: return "Database"
        case .folder: return "New folder"
        }
    }

    var baseName: String {
        switch self {
        case .markdown: return "New file"
        case .drawing: return "New drawing"
        case .database: return "New database"
        case .folder: return "New folder"
        }
    }

    var fileExtension: String? { self == .folder ? nil : rawValue }
}

/// Naming rules of the file tree's create, duplicate, rename, move and delete
/// (file-tree.tsx, files-store.ts, tree-context-menu.tsx).
public enum FileNaming {
    /// `New file.md`, then `New file 2.md`, … the first name free among the siblings.
    public static func newEntryName(_ kind: NewEntryKind, siblings: [String]) -> String {
        let taken = Set(siblings)
        var counter = 1
        while true {
            let display = counter == 1 ? kind.baseName : "\(kind.baseName) \(counter)"
            let name = kind.fileExtension.map { "\(display).\($0)" } ?? display
            if !taken.contains(name) { return name }
            counter += 1
        }
    }

    /// The content a new file starts with (`getInitialContent`); `directory` is
    /// where it is created, root-relative.
    public static func initialContent(_ kind: NewEntryKind, directory: String) -> String {
        switch kind {
        case .markdown, .folder:
            return ""
        case .drawing:
            return """
            {
              "type": "excalidraw",
              "version": 2,
              "source": "chro",
              "elements": [],
              "appState": {
                "viewBackgroundColor": "#ffffff",
                "gridSize": null
              },
              "files": {},
              "fileRefs": {}
            }
            """
        case .database:
            let folder = directory.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let include = folder.isEmpty ? "**/*.md" : "\(folder)/**/*.md"
            return [
                "version: 1", "name: \"Untitled\"", "dataset:", "  include: [\"\(include)\"]", "properties:", "  title:",
                "    key: \"title\"", "    type: \"text\"", "views:", "  - id: default", "    name: \"All\"", "    type: \"table\"",
                "    default: true",
            ].joined(separator: "\n") + "\n"
        }
    }

    /// `name copy.ext`, then `name copy 2.ext`, … (a leading dot is part of the name).
    public static func duplicateName(_ name: String, isDirectory: Bool, siblings: [String]) -> String {
        var base = name, ext = ""
        if !isDirectory, let dot = name.lastIndex(of: "."), dot != name.startIndex {
            base = String(name[..<dot])
            ext = String(name[dot...])
        }
        let taken = Set(siblings)
        var candidate = "\(base) copy\(ext)"
        var counter = 2
        while taken.contains(candidate) {
            candidate = "\(base) copy \(counter)\(ext)"
            counter += 1
        }
        return candidate
    }

    /// The renamed path, or nil when the inline rename should just close
    /// (empty, unchanged, containing `/`, or taken).
    public static func renameTarget(from path: String, to typed: String, existing: Set<String>) -> String? {
        let name = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        let current = path.split(separator: "/").last.map(String.init) ?? path
        guard !name.isEmpty, name != current, !name.contains("/") else { return nil }
        let parent = FileTree.parent(of: path)
        let target = parent.isEmpty ? name : "\(parent)/\(name)"
        return existing.contains(target) ? nil : target
    }

    /// The part of the name the inline rename selects: up to the extension for files.
    public static func renameSelection(_ name: String, isDirectory: Bool) -> Range<Int> {
        guard !isDirectory, let dot = name.lastIndex(of: "."), dot != name.startIndex else { return 0..<name.count }
        return 0..<name.distance(from: name.startIndex, to: dot)
    }

    /// Move to…: the project root (`""`) and every folder that is not the moved
    /// entry or inside it, filtered by the search field.
    public static func moveDestinations(moving path: String, folders: [String], query: String) -> [String] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let candidates = [""] + folders.filter { $0 != path && !$0.hasPrefix(path + "/") }.sorted()
        return candidates.filter { needle.isEmpty || ($0.isEmpty ? projectRootLabel : $0).lowercased().contains(needle) }
    }

    public static let projectRootLabel = "Project root"

    /// Where `path` lands when moved into `folder`.
    public static func moveTarget(moving path: String, into folder: String) -> String {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        return folder.isEmpty ? name : "\(folder)/\(name)"
    }

    /// `path` after `from` was renamed or moved to `to`.
    public static func relocate(_ path: String, from: String, to: String) -> String {
        if path == from { return to }
        if path.hasPrefix(from + "/") { return to + path.dropFirst(from.count) }
        return path
    }

    public static func deleteTitle(name: String) -> String { "Delete \(name)?" }

    public static func deleteMessage(isDirectory: Bool) -> String {
        "This action cannot be undone. This will permanently delete the \(isDirectory ? "folder and all its contents" : "file")."
    }
}
