import ChroAPI
import Foundation

/// The `.cbase` view document the server's `cbase/query` returns (crates/cbase
/// types.rs, desktop cbase/types.ts). Property and view keys are the server's
/// camel- or snake-case spellings, kept verbatim so the definition round-trips
/// through `cbase/persist` unchanged.
public enum CbasePropertyType: String, Codable, Sendable, CaseIterable {
    case text, number, checkbox, date, select
    case multiSelect = "multi_select"
    case url
}

public struct CbaseProperty: Codable, Equatable, Sendable {
    public var key: String
    public var label: String?
    public var type: CbasePropertyType
    public var required: Bool?
    public var `default`: JSONValue?
    public var options: [String]?

    public init(key: String, label: String? = nil, type: CbasePropertyType, options: [String]? = nil) {
        self.key = key
        self.label = label
        self.type = type
        self.options = options
    }
}

public enum CbaseFilterOperator: String, Codable, Sendable, CaseIterable {
    case equal = "="
    case notEqual = "!="
    case less = "<"
    case greater = ">"
    case atMost = "<="
    case atLeast = ">="
    case contains
    case notContains = "not_contains"
    case startsWith = "starts_with"
    case endsWith = "ends_with"
    case isEmpty = "is_empty"
    case isNotEmpty = "is_not_empty"
}

public struct CbaseFilterCondition: Codable, Equatable, Sendable {
    public var property: String
    public var op: CbaseFilterOperator
    public var value: JSONValue?

    public init(property: String, op: CbaseFilterOperator, value: JSONValue? = nil) {
        self.property = property
        self.op = op
        self.value = value
    }
}

/// `{and: […]}`, `{or: […]}`, `{not: …}` or a condition (serde untagged).
public indirect enum CbaseFilter: Codable, Equatable, Sendable {
    case and([CbaseFilter])
    case or([CbaseFilter])
    case not(CbaseFilter)
    case condition(CbaseFilterCondition)

    private enum Keys: String, CodingKey { case and, or, not }

    public init(from decoder: Decoder) throws {
        let keyed = try decoder.container(keyedBy: Keys.self)
        if let all = try keyed.decodeIfPresent([CbaseFilter].self, forKey: .and) { self = .and(all); return }
        if let any = try keyed.decodeIfPresent([CbaseFilter].self, forKey: .or) { self = .or(any); return }
        if let inner = try keyed.decodeIfPresent(CbaseFilter.self, forKey: .not) { self = .not(inner); return }
        self = .condition(try CbaseFilterCondition(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .and(let all):
            var keyed = encoder.container(keyedBy: Keys.self)
            try keyed.encode(all, forKey: .and)
        case .or(let any):
            var keyed = encoder.container(keyedBy: Keys.self)
            try keyed.encode(any, forKey: .or)
        case .not(let inner):
            var keyed = encoder.container(keyedBy: Keys.self)
            try keyed.encode(inner, forKey: .not)
        case .condition(let condition):
            try condition.encode(to: encoder)
        }
    }
}

public enum CbaseSortDirection: String, Codable, Sendable { case asc, desc }

public struct CbaseSort: Codable, Equatable, Sendable {
    public var by: String
    public var dir: CbaseSortDirection

    public init(by: String, dir: CbaseSortDirection) {
        self.by = by
        self.dir = dir
    }
}

public struct CbaseTableView: Codable, Equatable, Sendable {
    public var columns: [String]
    public var column_widths: [String: Double]?
    public var row_height: Double?

    public init(columns: [String]) { self.columns = columns }
}

public struct CbaseView: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var type: String
    public var `default`: Bool?
    public var filters: [CbaseFilter]?
    public var sort: [CbaseSort]?
    public var limit: Int?
    public var table: CbaseTableView?

    public init(id: String, name: String, type: String = "table", filters: [CbaseFilter]? = nil, sort: [CbaseSort]? = nil, table: CbaseTableView? = nil) {
        self.id = id
        self.name = name
        self.type = type
        self.filters = filters
        self.sort = sort
        self.table = table
    }
}

public struct CbaseDataset: Codable, Equatable, Sendable {
    public var include: [String]
    public var exclude: [String]?

    public init(include: [String], exclude: [String]? = nil) {
        self.include = include
        self.exclude = exclude
    }
}

public struct CbaseTemplate: Codable, Equatable, Sendable {
    public var folder: String
    public var filename: String
    public var frontmatter: [String: JSONValue]?
    public var body: String?
}

public struct CbaseDefinition: Codable, Equatable, Sendable {
    public var version: Int
    public var name: String
    public var description: String?
    public var dataset: CbaseDataset
    public var properties: [String: CbaseProperty]
    public var filters: [CbaseFilter]?
    public var sort: [CbaseSort]?
    public var views: [CbaseView]
    public var template: CbaseTemplate?

    public init(version: Int = 1, name: String, dataset: CbaseDataset, properties: [String: CbaseProperty],
                filters: [CbaseFilter]? = nil, views: [CbaseView]) {
        self.version = version
        self.name = name
        self.dataset = dataset
        self.properties = properties
        self.filters = filters
        self.views = views
    }
}

/// One materialized row (camelCase on the wire).
public struct CbaseRow: Codable, Equatable, Sendable, Identifiable {
    public var filePath: String
    public var displayName: String
    public var modifiedAt: String?
    public var values: [String: JSONValue]
    public var id: String { filePath }

    public init(filePath: String, displayName: String, modifiedAt: String? = nil, values: [String: JSONValue]) {
        self.filePath = filePath
        self.displayName = displayName
        self.modifiedAt = modifiedAt
        self.values = values
    }
}

public struct CbaseViewResult: Codable, Equatable, Sendable {
    public var view: CbaseView
    public var rows: [CbaseRow]
    public var totalCount: Int
    public var pageOffset: Int
    public var hasMore: Bool

    public init(view: CbaseView, rows: [CbaseRow], totalCount: Int, pageOffset: Int = 0, hasMore: Bool = false) {
        self.view = view
        self.rows = rows
        self.totalCount = totalCount
        self.pageOffset = pageOffset
        self.hasMore = hasMore
    }
}

public struct CbaseDocument: Codable, Equatable, Sendable {
    public var definition: CbaseDefinition?
    public var properties: [String: CbaseProperty]
    public var views: [CbaseViewResult]
    public var isQueryLanguage: Bool
    public var parseError: String?

    public init(definition: CbaseDefinition?, properties: [String: CbaseProperty], views: [CbaseViewResult],
                isQueryLanguage: Bool = false, parseError: String? = nil) {
        self.definition = definition
        self.properties = properties
        self.views = views
        self.isQueryLanguage = isQueryLanguage
        self.parseError = parseError
    }
}
