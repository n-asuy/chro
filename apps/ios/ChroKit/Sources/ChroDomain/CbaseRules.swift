import ChroAPI
import Foundation

/// The `.cbase` viewer's rules: the desktop table's labels and choices
/// (cbase-table.tsx, view-model.ts, runtime.ts) and the engine's value
/// semantics (crates/cbase value.rs and engine.rs), which the fixture uses to
/// answer `cbase/query` the way the server does.
public enum CbaseRules {
    // MARK: Filter and sort choices

    public static func label(_ op: CbaseFilterOperator) -> String {
        switch op {
        case .equal: "is"
        case .notEqual: "is not"
        case .less: "is less than"
        case .greater: "is greater than"
        case .atMost: "is at most"
        case .atLeast: "is at least"
        case .contains: "contains"
        case .notContains: "does not contain"
        case .startsWith: "starts with"
        case .endsWith: "ends with"
        case .isEmpty: "is empty"
        case .isNotEmpty: "is not empty"
        }
    }

    public static func needsValue(_ op: CbaseFilterOperator) -> Bool { op != .isEmpty && op != .isNotEmpty }

    public static func allowedOperators(_ property: CbaseProperty?) -> [CbaseFilterOperator] {
        guard let property else { return [.contains, .isEmpty, .isNotEmpty] }
        switch property.type {
        case .number, .date: return [.equal, .notEqual, .less, .greater, .atMost, .atLeast, .isEmpty, .isNotEmpty]
        case .checkbox, .select: return [.equal, .notEqual, .isEmpty, .isNotEmpty]
        case .text, .multiSelect, .url: return [.equal, .notEqual, .contains, .notContains, .startsWith, .endsWith, .isEmpty, .isNotEmpty]
        }
    }

    public static func defaultOperator(_ property: CbaseProperty?) -> CbaseFilterOperator {
        switch property?.type {
        case .number?, .date?, .checkbox?, .select?: .equal
        default: .contains
        }
    }

    /// Ascending and descending labels of the sort menu.
    public static func sortLabels(_ property: CbaseProperty?) -> (String, String) {
        switch property?.type {
        case nil: ("As returned", "As returned")
        case .date?: ("Old to new", "New to old")
        case .number?: ("Low to high", "High to low")
        case .checkbox?: ("False to true", "True to false")
        default: ("A to Z", "Z to A")
        }
    }

    public static func defaultSortDirection(_ property: CbaseProperty?) -> CbaseSortDirection {
        property?.type == .date ? .desc : .asc
    }

    /// The filter value as the desktop stores it: booleans for checkboxes,
    /// numbers when a number property's text parses, else the text.
    public static func typedFilterValue(_ text: String, _ property: CbaseProperty?) -> JSONValue {
        switch property?.type {
        case .checkbox?: return .bool(text == "true")
        case .number?: return Double(text.trimmingCharacters(in: .whitespaces)).map(JSONValue.number) ?? .string(text)
        default: return .string(text)
        }
    }

    /// A filter chip: `label op value`.
    public static func summary(_ condition: CbaseFilterCondition, _ properties: [String: CbaseProperty]) -> String {
        let property = properties[condition.property]
        let name = property?.label ?? property?.key ?? condition.property
        let value = needsValue(condition.op) ? filterText(condition.value) : ""
        return "\(name) \(label(condition.op))\(value.isEmpty ? "" : " \(value)")"
    }

    /// A filter of any shape, as its chip's title reads (`formatFilterSummary`).
    public static func summary(_ filter: CbaseFilter, _ properties: [String: CbaseProperty]) -> String {
        switch filter {
        case .condition(let condition): summary(condition, properties)
        case .and(let all): "All of: " + all.map { summary($0, properties) }.joined(separator: "; ")
        case .or(let any): "Any of: " + any.map { summary($0, properties) }.joined(separator: "; ")
        case .not(let inner): "None of: " + summary(inner, properties)
        }
    }

    private static func filterText(_ value: JSONValue?) -> String {
        switch value {
        case .bool(let flag)?: flag ? "true" : "false"
        case nil, .null?: ""
        case let other?: displayString(other)
        }
    }

    // MARK: Columns and rows

    private static let defaultColumnKeys = ["file.path", "file.name", "file.mtime"]

    /// The view's columns, or the file built-ins the definition declares.
    public static func columns(_ view: CbaseView, _ properties: [String: CbaseProperty]) -> [String] {
        if let columns = view.table?.columns, !columns.isEmpty { return columns }
        let byKey = Dictionary(properties.map { ($0.value.key, $0.key) }, uniquingKeysWith: { first, _ in first })
        let defaults = defaultColumnKeys.compactMap { byKey[$0] }
        return defaults.isEmpty ? properties.keys.sorted() : defaults
    }

    public static func columnLabel(_ id: String, _ properties: [String: CbaseProperty]) -> String {
        guard let property = properties[id] else { return id }
        return property.label ?? property.key
    }

    /// Whether a property is written back as frontmatter (`file.*` cannot be).
    public static func isEditable(_ property: CbaseProperty?) -> Bool {
        guard let property else { return false }
        return !property.key.hasPrefix("file.")
    }

    /// A row's value for a property id, `file.*` built-ins included; nil when absent.
    public static func value(_ row: CbaseRow, _ propertyID: String, _ properties: [String: CbaseProperty]) -> JSONValue? {
        guard let property = properties[propertyID] else { return nil }
        switch property.key {
        case "file.path": return .string(row.filePath)
        case "file.name": return .string(row.displayName)
        case "file.folder": return .string(row.filePath.contains("/") ? String(row.filePath[..<row.filePath.lastIndex(of: "/")!]) : "")
        case "file.mtime", "file.modified", "file.modifiedAt": return row.modifiedAt.map(JSONValue.string)
        case "file.ext": return .string(row.filePath.contains(".") ? String(row.filePath[row.filePath.index(after: row.filePath.lastIndex(of: ".")!)...]) : "")
        default: return row.values[property.key]
        }
    }

    /// A cell's text (`formatPropertyValue`).
    public static func format(_ value: JSONValue?) -> String {
        switch value {
        case nil, .null?: return "—"
        case .string(let text)?: return text.isEmpty ? "—" : text
        case .number(let number)?: return number.isFinite ? number.shortDisplay : "—"
        case .bool(let flag)?: return flag ? "true" : "false"
        case .array(let items)?: return items.isEmpty ? "—" : items.map(displayString).joined(separator: ", ")
        case .object?: return "[object Object]"
        }
    }

    public static func countLabel(shown: Int, total: Int) -> String {
        shown < total ? "\(grouped(shown)) shown · \(grouped(total)) matches" : "\(grouped(total)) results"
    }

    private static func grouped(_ number: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US")
        return formatter.string(from: NSNumber(value: number)) ?? String(number)
    }

    // MARK: New rows

    /// The static folder prefix of the dataset's first include glob.
    public static func datasetFolder(_ dataset: CbaseDataset?) -> String {
        var folder: [Substring] = []
        for segment in (dataset?.include.first ?? "").split(separator: "/", omittingEmptySubsequences: false) {
            if segment.contains("*") || segment.contains("?") || segment.contains(".") { break }
            folder.append(segment)
        }
        return folder.joined(separator: "/")
    }

    /// The first `untitled[-N].md` not in `existing`.
    public static func nextUntitledPath(folder: String, existing: Set<String>) -> String {
        let prefix = folder.isEmpty ? "" : folder + "/"
        var n = 0
        while true {
            let candidate = "\(prefix)\(n == 0 ? "untitled" : "untitled-\(n)").md"
            if !existing.contains(candidate) { return candidate }
            n += 1
        }
    }

    /// An empty frontmatter block for every visible editable property.
    public static func newNoteContent(_ view: CbaseView, _ properties: [String: CbaseProperty]) -> String {
        let keys = columns(view, properties).compactMap { properties[$0] }.filter(isEditable).map(\.key)
        guard !keys.isEmpty else { return "" }
        return "---\n" + keys.map { "\($0):" }.joined(separator: "\n") + "\n---\n"
    }

    // MARK: Engine semantics

    public static func isEmpty(_ value: JSONValue?) -> Bool {
        switch value {
        case nil, .null?: true
        case .string(let text)?: text.trimmingCharacters(in: .whitespaces).isEmpty
        case .array(let items)?: items.isEmpty
        default: false
        }
    }

    /// Three-way comparison with empty values first (value.rs `compare`).
    public static func compare(_ a: JSONValue?, _ b: JSONValue?) -> ComparisonResult {
        let (aEmpty, bEmpty) = (isEmpty(a), isEmpty(b))
        if aEmpty && bEmpty { return .orderedSame }
        if aEmpty { return .orderedAscending }
        if bEmpty { return .orderedDescending }
        if case .number = a { return ordering(number(a), number(b)) }
        if case .number = b { return ordering(number(a), number(b)) }
        if case .bool(let x)? = a, case .bool(let y)? = b { return ordering(x ? 1 : 0, y ? 1 : 0) }
        let (x, y) = (displayString(a ?? .null), displayString(b ?? .null))
        return x == y ? .orderedSame : (x < y ? .orderedAscending : .orderedDescending)
    }

    public static func matches(_ row: CbaseRow, _ filter: CbaseFilter, _ properties: [String: CbaseProperty]) -> Bool {
        switch filter {
        case .and(let all): return all.allSatisfy { matches(row, $0, properties) }
        case .or(let any): return any.contains { matches(row, $0, properties) }
        case .not(let inner): return !matches(row, inner, properties)
        case .condition(let condition):
            let value = Self.value(row, condition.property, properties)
            let target = condition.value
            let needle = displayString(target ?? .null).lowercased()
            switch condition.op {
            case .isEmpty: return isEmpty(value)
            case .isNotEmpty: return !isEmpty(value)
            case .equal: return compare(value, target) == .orderedSame
            case .notEqual: return compare(value, target) != .orderedSame
            case .less: return compare(value, target) == .orderedAscending
            case .greater: return compare(value, target) == .orderedDescending
            case .atMost: return compare(value, target) != .orderedDescending
            case .atLeast: return compare(value, target) != .orderedAscending
            case .contains: return contains(value, needle)
            case .notContains: return !contains(value, needle)
            case .startsWith: return displayString(value ?? .null).lowercased().hasPrefix(needle)
            case .endsWith: return displayString(value ?? .null).lowercased().hasSuffix(needle)
            }
        }
    }

    /// Rows after the definition's and the view's filters, sorted by the view's
    /// (else the definition's) sort with ties on the path (engine `execute_view`).
    public static func execute(_ rows: [CbaseRow], view: CbaseView, definition: CbaseDefinition) -> [CbaseRow] {
        let filters = (definition.filters ?? []) + (view.filters ?? [])
        var result = rows.filter { row in filters.allSatisfy { matches(row, $0, definition.properties) } }
        let sort = (view.sort?.isEmpty == false ? view.sort : definition.sort) ?? []
        if !sort.isEmpty {
            result.sort { a, b in
                for spec in sort {
                    let order = compare(value(a, spec.by, definition.properties), value(b, spec.by, definition.properties))
                    if order != .orderedSame { return spec.dir == .asc ? order == .orderedAscending : order == .orderedDescending }
                }
                return a.filePath < b.filePath
            }
        }
        if let limit = view.limit, limit > 0, result.count > limit { result = Array(result.prefix(limit)) }
        return result
    }

    private static func contains(_ value: JSONValue?, _ needle: String) -> Bool {
        if case .array(let items)? = value { return items.contains { displayString($0).lowercased().contains(needle) } }
        return displayString(value ?? .null).lowercased().contains(needle)
    }

    private static func number(_ value: JSONValue?) -> Double {
        switch value {
        case .number(let number)?: number
        case .bool(let flag)?: flag ? 1 : 0
        case .string(let text)?: Double(text.trimmingCharacters(in: .whitespaces)) ?? 0
        default: 0
        }
    }

    private static func ordering(_ a: Double, _ b: Double) -> ComparisonResult {
        a == b ? .orderedSame : (a < b ? .orderedAscending : .orderedDescending)
    }

    static func displayString(_ value: JSONValue) -> String {
        switch value {
        case .null: ""
        case .string(let text): text
        case .bool(let flag): flag ? "true" : "false"
        case .number(let number): number.shortDisplay
        case .array(let items): items.map(displayString).joined(separator: ", ")
        case .object: "[object Object]"
        }
    }
}

extension Double {
    /// `5` rather than `5.0`, as JavaScript prints numbers.
    var shortDisplay: String {
        rounded() == self && abs(self) < 1e15 ? String(Int64(self)) : String(self)
    }
}
