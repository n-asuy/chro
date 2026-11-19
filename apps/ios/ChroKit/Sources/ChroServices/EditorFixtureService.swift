import ChroAPI
import ChroDomain
import Foundation

/// EditorService over the mock's checkouts. Writes go through the shared
/// `DockFixtureCheckouts`, so Files, Search, Source Control and Diff see them.
/// The `.cbase` engine is answered here the way crates/cbase answers it
/// (dataset glob, frontmatter values, filters, sort), over the project checkout.
final class EditorFixtureService: EditorService, @unchecked Sendable {
    private let checkouts: DockFixtureCheckouts
    /// What the server appends to an opted-in HTML document (`PREVIEW_BRIDGE_SUFFIX`
    /// in crates/server asset_response.rs); the app passes the bundled scripts.
    private let previewBridge: String

    init(checkouts: DockFixtureCheckouts, previewBridge: String = "") {
        self.checkouts = checkouts
        self.previewBridge = previewBridge
    }

    static var inlineTextLimit: Int { 2 * 1024 * 1024 }
    static var previewBytes: Int { 512 * 1024 }

    func read(_ path: String, in scope: CheckoutScope) async throws -> TextFile {
        let node = try node(path, in: scope)
        let content: String
        switch node {
        case .directory: throw EditorError.notFound("target is not a file")
        case .text(let text): content = text
        case .binary(let data, _): content = String(decoding: data, as: UTF8.self)
        }
        let bytes = Array(content.utf8)
        guard bytes.count > Self.inlineTextLimit else {
            return TextFile(path: path, content: content, size: bytes.count, modifiedAt: modified(path, in: scope))
        }
        let preview = String(decoding: bytes.prefix(Self.previewBytes), as: UTF8.self)
        return TextFile(path: path, content: preview, size: bytes.count, truncated: true, modifiedAt: modified(path, in: scope))
    }

    func write(_ path: String, content: String, in scope: CheckoutScope) async throws -> TextFile {
        let written: Void? = checkouts.update(scope) { checkout in
            var directory = FilePath.directory(path)
            while !directory.isEmpty {
                if checkout.nodes[directory] == nil { checkout.nodes[directory] = .directory }
                directory = FilePath.directory(directory)
            }
            checkout.nodes[path] = .text(content)
            checkout.modified[path] = Date()
        }
        guard written != nil else { throw EditorError.refused("workspace directory does not exist") }
        return TextFile(path: path, content: content, size: content.utf8.count, modifiedAt: modified(path, in: scope))
    }

    func readBinary(_ path: String, in scope: CheckoutScope) async throws -> BinaryFile {
        switch try node(path, in: scope) {
        case .directory: throw EditorError.notFound("target is not a file")
        case .binary(let data, let type): return BinaryFile(data: data, contentType: type)
        case .text(let text): return BinaryFile(data: Data(text.utf8), contentType: Self.contentType(path))
        }
    }

    func readAsset(_ path: String, query: [String: String], in scope: CheckoutScope) async throws -> AssetResponse {
        let type = Self.contentType(path)
        switch checkouts.checkout(scope)?.nodes[path] {
        case nil, .directory?:
            return AssetResponse(status: 404, contentType: "text/plain; charset=utf-8", data: Data(EditorError.missingText.utf8))
        case .binary(let data, let stored)?:
            return AssetResponse(status: 200, contentType: stored, data: data)
        case .text(let text)?:
            let bridged = type == "text/html" && ["1", "true"].contains(query["preview_bridge"] ?? "")
            return AssetResponse(status: 200, contentType: type, data: Data((bridged ? text + previewBridge : text).utf8))
        }
    }

    func resolve(_ reference: String, in scope: CheckoutScope) async throws -> String? {
        guard let files = checkouts.checkout(scope)?.files else { return nil }
        let wanted = reference.lowercased()
        let candidates = files.filter { path in
            let lower = path.lowercased()
            return lower == wanted || lower.hasSuffix("/" + wanted)
                || lower == wanted + ".md" || lower.hasSuffix("/" + wanted + ".md")
        }
        // Shortest path wins among duplicate names, as the server's name index does.
        return candidates.min { ($0.count, $0) < ($1.count, $1) }
    }

    func queryBase(projectID: String, path: String, content: String, viewID: String?) async throws -> CbaseDocument {
        guard let definition = try? JSONDecoder().decode(CbaseDefinition.self, from: Data(content.utf8)) else {
            return CbaseDocument(definition: nil, properties: [:], views: [], parseError: "The file is not a valid .cbase definition.")
        }
        return document(definition, projectID: projectID)
    }

    func persistBase(projectID: String, path: String, definition: CbaseDefinition, properties: [String: CbaseProperty],
                     viewID: String?) async throws -> CbasePersisted {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let content = String(decoding: try encoder.encode(definition), as: UTF8.self) + "\n"
        _ = try await write(path, content: content, in: .project(id: projectID))
        return CbasePersisted(content: content, document: document(definition, projectID: projectID))
    }

    func setBaseProperty(projectID: String, filePath: String, key: String, value: JSONValue) async throws {
        let scope = CheckoutScope.project(id: projectID)
        let note = try await read(filePath, in: scope).content
        var lines = note.components(separatedBy: "\n")
        var properties = Frontmatter.parse(lines).properties
        if case .null = value {
            properties.removeAll { $0.key == key }
        } else if let index = properties.firstIndex(where: { $0.key == key }) {
            properties[index].value = Self.frontmatterValue(value)
        } else {
            properties.append(FrontmatterProperty(key: key, value: Self.frontmatterValue(value)))
        }
        lines = Frontmatter.write(properties, into: lines)
        _ = try await write(filePath, content: lines.joined(separator: "\n"), in: scope)
    }

    // MARK: Helpers

    private func node(_ path: String, in scope: CheckoutScope) throws -> FixtureNode {
        guard let node = checkouts.checkout(scope)?.nodes[path] else { throw EditorError.notFound(EditorError.missingText) }
        return node
    }

    private func modified(_ path: String, in scope: CheckoutScope) -> Date? { checkouts.checkout(scope)?.modified[path] }

    private func document(_ definition: CbaseDefinition, projectID: String) -> CbaseDocument {
        let checkout = checkouts.checkout(.project(id: projectID))
        let rows = (checkout?.files ?? []).filter { Self.included($0, by: definition.dataset) }.compactMap { path -> CbaseRow? in
            guard let text = checkout?.nodes[path]?.text else { return nil }
            let values = Frontmatter.parse(text.components(separatedBy: "\n")).properties.reduce(into: [String: JSONValue]()) {
                $0[$1.key] = Self.jsonValue($1.value)
            }
            return CbaseRow(filePath: path, displayName: FilePath.stem(path), values: values)
        }
        let views = definition.views.map { view in
            let result = CbaseRules.execute(rows, view: view, definition: definition)
            return CbaseViewResult(view: view, rows: result, totalCount: result.count)
        }
        return CbaseDocument(definition: definition, properties: definition.properties, views: views)
    }

    /// The dataset's include globs (`*` within a segment, `**` across segments), minus its excludes.
    static func included(_ path: String, by dataset: CbaseDataset) -> Bool {
        dataset.include.contains { glob($0, matches: path) } && !(dataset.exclude ?? []).contains { glob($0, matches: path) }
    }

    static func glob(_ pattern: String, matches path: String) -> Bool {
        var expression = "^"
        var index = pattern.startIndex
        while index < pattern.endIndex {
            let character = pattern[index]
            if character == "*" {
                let next = pattern.index(after: index)
                if next < pattern.endIndex, pattern[next] == "*" {
                    expression += ".*"
                    index = pattern.index(after: next)
                    if index < pattern.endIndex, pattern[index] == "/" { expression += "/?"; index = pattern.index(after: index) }
                    continue
                }
                expression += "[^/]*"
            } else if character == "?" {
                expression += "[^/]"
            } else {
                expression += NSRegularExpression.escapedPattern(for: String(character))
            }
            index = pattern.index(after: index)
        }
        return path.range(of: expression + "$", options: .regularExpression) != nil
    }

    static func jsonValue(_ value: FrontmatterValue) -> JSONValue {
        switch value {
        case .text(let text), .date(let text), .nested(let text): .string(text)
        case .number(let number): .number(number)
        case .checkbox(let flag): .bool(flag)
        case .tags(let tags): .array(tags.map(JSONValue.string))
        }
    }

    static func frontmatterValue(_ value: JSONValue) -> FrontmatterValue {
        switch value {
        case .number(let number): .number(number)
        case .bool(let flag): .checkbox(flag)
        case .array(let items): .tags(items.compactMap(\.stringValue))
        case .string(let text): Frontmatter.isDate(text) ? .date(text) : .text(text)
        case .null, .object: .text("")
        }
    }

    static func contentType(_ path: String) -> String {
        switch FilePath.ext(path) {
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "webp": "image/webp"
        case "svg": "image/svg+xml"
        case "pdf": "application/pdf"
        case "html", "htm": "text/html"
        case "css": "text/css"
        case "js", "mjs": "text/javascript"
        case "mp4", "m4v": "video/mp4"
        case "mov": "video/quicktime"
        case "mp3": "audio/mpeg"
        case "m4a": "audio/mp4"
        case "wav": "audio/wav"
        default: "application/octet-stream"
        }
    }
}
