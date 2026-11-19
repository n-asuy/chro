import Foundation

/// Delimiter-separated values (files/lib/csv.ts): an RFC 4180 parser and
/// serializer that keeps the delimiter, line ending and trailing newline it
/// found, so an untouched file round-trips byte for byte. Row 0 is the header.
public struct CSVTable: Equatable, Sendable {
    public var rows: [[String]]
    public var columnCount: Int
    public var delimiter: Character
    public var lineEnding: String
    public var trailingNewline: Bool

    public static func delimiter(forPath path: String) -> Character {
        FilePath.ext(path) == "tsv" ? "\t" : ","
    }

    public static func parse(_ input: String, delimiter: Character = ",") -> CSVTable {
        let text = input.hasPrefix("\u{FEFF}") ? String(input.dropFirst()) : input
        let lineEnding = text.contains("\r\n") ? "\r\n" : "\n"
        let trailingNewline = text.unicodeScalars.last == "\n"
        guard !text.isEmpty else {
            return CSVTable(rows: [[""]], columnCount: 1, delimiter: delimiter, lineEnding: "\n", trailingNewline: false)
        }
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var inQuotes = false
        let characters = Array(text.unicodeScalars)
        var index = 0
        while index < characters.count {
            let character = Character(characters[index])
            if inQuotes {
                if character == "\"" {
                    if index + 1 < characters.count, characters[index + 1] == "\"" {
                        field.append("\"")
                        index += 1
                    } else {
                        inQuotes = false
                    }
                } else {
                    field.append(character)
                }
            } else if character == "\"" {
                inQuotes = true
            } else if character == delimiter {
                row.append(field)
                field = ""
            } else if character == "\r" || character == "\n" {
                row.append(field)
                field = ""
                rows.append(row)
                row = []
                if character == "\r", index + 1 < characters.count, characters[index + 1] == "\n" { index += 1 }
            } else {
                field.append(character)
            }
            index += 1
        }
        if !field.isEmpty || !row.isEmpty {
            row.append(field)
            rows.append(row)
        }
        let width = max(1, rows.map(\.count).max() ?? 1)
        return CSVTable(rows: rows.map { $0 + Array(repeating: "", count: width - $0.count) }, columnCount: width,
                        delimiter: delimiter, lineEnding: lineEnding, trailingNewline: trailingNewline)
    }

    public func serialized() -> String {
        let body = rows.map { $0.map(encode).joined(separator: String(delimiter)) }.joined(separator: lineEnding)
        return trailingNewline ? body + lineEnding : body
    }

    /// Data rows (below the header).
    public var dataRowCount: Int { max(0, rows.count - 1) }

    public mutating func set(row: Int, column: Int, to value: String) {
        guard rows.indices.contains(row), column < columnCount else { return }
        rows[row][column] = value
    }

    public mutating func insertRow(at index: Int) {
        rows.insert(Array(repeating: "", count: columnCount), at: min(max(0, index), rows.count))
    }

    public mutating func insertColumn(at index: Int) {
        let at = min(max(0, index), columnCount)
        for row in rows.indices { rows[row].insert("", at: at) }
        columnCount += 1
    }

    public mutating func deleteRow(_ index: Int) {
        guard rows.indices.contains(index) else { return }
        rows.remove(at: index)
        if rows.isEmpty { self = CSVTable.parse("", delimiter: delimiter) }
    }

    public mutating func deleteColumn(_ index: Int) {
        guard index >= 0, index < columnCount else { return }
        guard columnCount > 1 else { self = CSVTable.parse("", delimiter: delimiter); return }
        for row in rows.indices { rows[row].remove(at: index) }
        columnCount -= 1
    }

    private func encode(_ field: String) -> String {
        let needsQuotes = field.contains(delimiter) || field.contains("\"") || field.contains("\n") || field.contains("\r")
        return needsQuotes ? "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\"" : field
    }
}
