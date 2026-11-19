import ChroAPI
import ChroDomain
import Foundation
import Testing

@Suite struct CbaseRulesTests {
    static let properties: [String: CbaseProperty] = [
        "name": CbaseProperty(key: "file.name", type: .text),
        "on_hand": CbaseProperty(key: "on_hand", type: .number),
        "status": CbaseProperty(key: "status", type: .select, options: ["ok", "low"]),
        "reviewed": CbaseProperty(key: "reviewed", type: .checkbox),
        "due": CbaseProperty(key: "due", type: .date),
    ]

    static func row(_ name: String, _ values: [String: JSONValue]) -> CbaseRow {
        CbaseRow(filePath: "docs/skus/\(name).md", displayName: name, values: values)
    }

    @Test func operatorLabelsAndAllowedOperatorsFollowThePropertyType() {
        #expect(CbaseRules.label(.atLeast) == "is at least")
        #expect(CbaseRules.label(.notContains) == "does not contain")
        #expect(CbaseRules.allowedOperators(Self.properties["on_hand"]) == [.equal, .notEqual, .less, .greater, .atMost, .atLeast, .isEmpty, .isNotEmpty])
        #expect(CbaseRules.allowedOperators(Self.properties["reviewed"]) == [.equal, .notEqual, .isEmpty, .isNotEmpty])
        #expect(CbaseRules.allowedOperators(nil) == [.contains, .isEmpty, .isNotEmpty])
        #expect(CbaseRules.defaultOperator(Self.properties["status"]) == .equal)
        #expect(CbaseRules.defaultOperator(Self.properties["name"]) == .contains)
        #expect(!CbaseRules.needsValue(.isEmpty))
    }

    @Test func sortLabelsAndDefaultDirection() {
        #expect(CbaseRules.sortLabels(Self.properties["on_hand"]) == ("Low to high", "High to low"))
        #expect(CbaseRules.sortLabels(Self.properties["reviewed"]) == ("False to true", "True to false"))
        #expect(CbaseRules.sortLabels(Self.properties["due"]) == ("Old to new", "New to old"))
        #expect(CbaseRules.sortLabels(Self.properties["status"]) == ("A to Z", "Z to A"))
        #expect(CbaseRules.defaultSortDirection(Self.properties["due"]) == .desc)
        #expect(CbaseRules.defaultSortDirection(Self.properties["on_hand"]) == .asc)
    }

    @Test func valuesResolveBuiltInsAndFrontmatter() {
        let row = Self.row("A1", ["on_hand": .number(5)])
        #expect(CbaseRules.value(row, "name", Self.properties) == .string("A1"))
        #expect(CbaseRules.value(row, "on_hand", Self.properties) == .number(5))
        #expect(CbaseRules.value(row, "missing", Self.properties) == nil)
        #expect(CbaseRules.format(.number(5)) == "5")
        #expect(CbaseRules.format(.number(2.5)) == "2.5")
        #expect(CbaseRules.format(nil) == "—")
        #expect(CbaseRules.format(.array([])) == "—")
        #expect(CbaseRules.format(.array([.string("a"), .string("b")])) == "a, b")
    }

    @Test func filtersEvaluateLikeTheEngine() {
        let low = Self.row("B2", ["on_hand": .number(1), "status": .string("low"), "reviewed": .bool(false)])
        let ok = Self.row("C3", ["on_hand": .number(12), "status": .string("ok"), "reviewed": .bool(true)])
        let isLow = CbaseFilter.condition(CbaseFilterCondition(property: "status", op: .equal, value: .string("low")))
        #expect(CbaseRules.matches(low, isLow, Self.properties))
        #expect(!CbaseRules.matches(ok, isLow, Self.properties))
        let atLeast = CbaseFilter.condition(CbaseFilterCondition(property: "on_hand", op: .atLeast, value: .number(5)))
        #expect(CbaseRules.matches(ok, atLeast, Self.properties))
        #expect(!CbaseRules.matches(low, atLeast, Self.properties))
        let contains = CbaseFilter.condition(CbaseFilterCondition(property: "name", op: .contains, value: .string("c")))
        #expect(CbaseRules.matches(ok, contains, Self.properties))
        #expect(CbaseRules.matches(low, .not(contains), Self.properties))
        let empty = CbaseFilter.condition(CbaseFilterCondition(property: "due", op: .isEmpty))
        #expect(CbaseRules.matches(low, empty, Self.properties))
    }

    @Test func compareOrdersEmptyFirstThenNumbersThenText() {
        #expect(CbaseRules.compare(nil, .number(1)) == .orderedAscending)
        #expect(CbaseRules.compare(.number(12), .number(5)) == .orderedDescending)
        #expect(CbaseRules.compare(.string("low"), .string("ok")) == .orderedAscending)
        #expect(CbaseRules.compare(.string("5"), .number(5)) == .orderedSame)
    }

    @Test func chipSummaryUsesTheLabelOrKey() {
        let filter = CbaseFilterCondition(property: "on_hand", op: .less, value: .number(4))
        #expect(CbaseRules.summary(filter, Self.properties) == "on_hand is less than 4")
        #expect(CbaseRules.summary(CbaseFilterCondition(property: "status", op: .isEmpty), Self.properties) == "status is empty")
        let low = CbaseFilter.condition(CbaseFilterCondition(property: "status", op: .equal, value: .string("low")))
        let checked = CbaseFilter.condition(CbaseFilterCondition(property: "reviewed", op: .equal, value: .bool(true)))
        #expect(CbaseRules.summary(.and([low, checked]), Self.properties) == "All of: status is low; reviewed is true")
        #expect(CbaseRules.summary(.or([low, checked]), Self.properties) == "Any of: status is low; reviewed is true")
        #expect(CbaseRules.summary(.not(low), Self.properties) == "None of: status is low")
    }

    @Test func filterValuesAreTypedForThePropertyBeforeSaving() {
        #expect(CbaseRules.typedFilterValue("true", Self.properties["reviewed"]) == .bool(true))
        #expect(CbaseRules.typedFilterValue("4", Self.properties["on_hand"]) == .number(4))
        #expect(CbaseRules.typedFilterValue("x4", Self.properties["on_hand"]) == .string("x4"))
        #expect(CbaseRules.typedFilterValue("low", Self.properties["status"]) == .string("low"))
    }

    @Test func columnsDefaultToFileBuiltInsWhenTheViewHasNone() {
        let view = CbaseView(id: "v", name: "V")
        #expect(CbaseRules.columns(view, Self.properties) == ["name"])
        let listed = CbaseView(id: "v", name: "V", table: CbaseTableView(columns: ["name", "on_hand"]))
        #expect(CbaseRules.columns(listed, Self.properties) == ["name", "on_hand"])
        #expect(CbaseRules.columnLabel("name", Self.properties) == "file.name")
        #expect(CbaseRules.columnLabel("ghost", Self.properties) == "ghost")
    }

    @Test func newRowsGoToTheFirstFreeUntitledNoteOfTheDatasetFolder() {
        #expect(CbaseRules.datasetFolder(CbaseDataset(include: ["docs/skus/*.md"])) == "docs/skus")
        #expect(CbaseRules.datasetFolder(CbaseDataset(include: ["**/*.md"])) == "")
        #expect(CbaseRules.nextUntitledPath(folder: "docs/skus", existing: ["docs/skus/untitled.md"]) == "docs/skus/untitled-1.md")
        let view = CbaseView(id: "v", name: "V", table: CbaseTableView(columns: ["name", "on_hand", "status"]))
        #expect(CbaseRules.newNoteContent(view, Self.properties) == "---\non_hand:\nstatus:\n---\n")
    }

    @Test func resultCountLabel() {
        #expect(CbaseRules.countLabel(shown: 3, total: 3) == "3 results")
        #expect(CbaseRules.countLabel(shown: 250, total: 1200) == "250 shown · 1,200 matches")
    }

    @Test func definitionRoundTripsThroughJSON() throws {
        let definition = CbaseDefinition(name: "reorder", dataset: CbaseDataset(include: ["docs/skus/*.md"]), properties: Self.properties,
                                          views: [CbaseView(id: "low", name: "Low stock", filters: [.condition(CbaseFilterCondition(property: "status", op: .equal, value: .string("low")))],
                                                            sort: [CbaseSort(by: "on_hand", dir: .asc)], table: CbaseTableView(columns: ["name"]))])
        let data = try JSONEncoder().encode(definition)
        #expect(try JSONDecoder().decode(CbaseDefinition.self, from: data) == definition)
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.contains("\"op\":\"=\""))
    }
}
