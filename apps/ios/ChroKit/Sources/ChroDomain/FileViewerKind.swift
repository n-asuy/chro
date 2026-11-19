import Foundation

/// Which viewer opens a file, by extension (the mock's `viewerFor`, the
/// desktop's files-editor dispatch).
public enum FileViewerKind: Equatable, Sendable {
    case image, pdf, scene, base, csv, prose, html, code, video, audio

    // media-types.ts, the single list the desktop's viewers share.
    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico", "tiff", "tif"]
    private static let videoExtensions: Set<String> = ["mp4", "webm", "mov", "avi", "mkv", "m4v"]
    private static let audioExtensions: Set<String> = ["mp3", "wav", "ogg", "m4a", "flac", "aac"]

    public init(path: String) {
        let ext = FilePath.ext(path)
        if Self.imageExtensions.contains(ext) { self = .image }
        else if Self.videoExtensions.contains(ext) { self = .video }
        else if Self.audioExtensions.contains(ext) { self = .audio }
        else if ext == "pdf" { self = .pdf }
        else if ext == "excalidraw" { self = .scene }
        else if ext == "cbase" { self = .base }
        else if ext == "csv" || ext == "tsv" { self = .csv }
        else if ["md", "mdx", "txt"].contains(ext) { self = .prose }
        else if ext == "html" || ext == "htm" { self = .html }
        else { self = .code }
    }

    /// Read as UTF-8 text (the `/file` endpoint) rather than bytes (`/binary-file`).
    public var isText: Bool { ![.image, .pdf, .video, .audio].contains(self) }
}

/// Byte counts as the editor's notices print them (files-editor.tsx `formatFileSize`).
public enum FileSize {
    public static func label(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return String(format: "%.1f KiB", Double(bytes) / 1024) }
        return String(format: "%.1f MiB", Double(bytes) / (1024 * 1024))
    }
}

/// Root-relative path helpers.
public enum FilePath {
    public static func name(_ path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? path
    }

    /// The name without its last extension (a leading dot does not start one).
    public static func stem(_ path: String) -> String {
        let file = name(path)
        guard let dot = file.lastIndex(of: "."), dot != file.startIndex else { return file }
        return String(file[..<dot])
    }

    /// The lowercased last extension, empty when there is none.
    public static func ext(_ path: String) -> String {
        let file = name(path)
        guard let dot = file.lastIndex(of: "."), dot != file.startIndex else { return "" }
        return file[file.index(after: dot)...].lowercased()
    }

    public static func directory(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[..<slash])
    }

    /// The same directory and extension with a new stem (renaming from a document title).
    public static func renamed(_ path: String, stem newStem: String) -> String {
        let file = name(path)
        let suffix = file.lastIndex(of: ".").flatMap { $0 == file.startIndex ? nil : String(file[$0...]) } ?? ""
        let dir = directory(path)
        return (dir.isEmpty ? "" : dir + "/") + newStem + suffix
    }
}
