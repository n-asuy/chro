import ChroAPI
import ChroDomain
import ChroServices
import SwiftUI

/// The `.cbase` view (cbase-viewer.tsx, cbase-table.tsx, the mock's
/// `baseViewer`): view tabs, the result count, Filter / Sort / Properties /
/// New, filter chips, and the table of notes. View changes are written to the
/// `.cbase` file (`cbase/persist`); cell edits rewrite the row note's
/// frontmatter (`cbase/set-property`), shown at once and settled by the re-query.
struct BaseFileView: View {
    let location: FileLocation
    let document: TextDocument
    @Environment(\.panelServices) private var services
    @Environment(\.reportRouteFailure) private var reportFailure
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ToastCenter.self) private var toasts
    @Environment(Router.self) private var router
    @State private var base: CbaseDocument?
    @State private var viewID: String?
    /// Optimistic cell values by `path\0key` until the re-query reflects them.
    @State private var overlay: [String: JSONValue] = [:]
    @State private var editingCell: String?
    @State private var numberDraft = ""
    @FocusState private var numberFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            FileNavBar(path: location.path)
            TextDocumentGate(document: document) {
                if let base {
                    if let error = base.parseError {
                        VStack(spacing: 6) {
                            Text("Invalid .cbase file").textStyle(TextStyle(size: 14, weight: 500)).foregroundStyle(Palette.fg)
                            Text(error).textStyle(TextStyle(size: 13)).foregroundStyle(Palette.t300).multilineTextAlignment(.center)
                        }
                        .padding(24)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        viewer(base)
                    }
                } else {
                    EditorStatus(text: "Loading file…")
                }
            }
        }
        .task(id: QueryKey(text: document.text, viewID: viewID, ready: document.phase == .ready)) { await query() }
    }

    private struct QueryKey: Equatable {
        var text: String
        var viewID: String?
        var ready: Bool
    }

    private func query() async {
        guard document.phase == .ready else { return }
        do {
            let result = try await services.editor.queryBase(projectID: location.projectID, path: location.path, content: document.text, viewID: viewID)
            base = result
            settleOverlay(result)
            if viewID == nil || !(result.definition?.views.contains { $0.id == viewID } ?? false) {
                viewID = result.definition?.views.first(where: { $0.default == true })?.id ?? result.definition?.views.first?.id
            }
        } catch let error as EditorError {
            toasts.show(error.message)
        } catch {
            reportFailure(RouteFailure(error))
        }
    }

    // MARK: Viewer

    private func viewer(_ base: CbaseDocument) -> some View {
        let definition = base.definition
        let view = definition?.views.first { $0.id == viewID } ?? definition?.views.first
        let result = base.views.first { $0.view.id == view?.id }
        let rows = (result?.rows ?? []).map(applyOverlay)
        let columns = view.map { CbaseRules.columns($0, base.properties) } ?? []
        return VStack(spacing: 0) {
            if let definition, let view {
                toolbar(definition, view: view, shown: rows.count, total: result?.totalCount ?? rows.count, properties: base.properties)
                chips(definition, view: view, properties: base.properties)
            }
            table(rows: rows, columns: columns, properties: base.properties)
        }
    }

    private func toolbar(_ definition: CbaseDefinition, view: CbaseView, shown: Int, total: Int, properties: [String: CbaseProperty]) -> some View {
        let filterCount = (definition.filters?.count ?? 0) + (view.filters?.count ?? 0)
        // `.cb-tool` wraps: the view tabs, the count and Filter, then Sort, Properties and New.
        return FlowLayout(spacing: 2) {
                ForEach(definition.views) { tab in
                    Button { viewID = tab.id } label: {
                        HStack(spacing: 6) {
                            Icon(.table2, size: 14)
                            Text(tab.name).textStyle(TextStyle(size: 13, weight: tab.id == view.id ? 500 : 400))
                        }
                        .foregroundStyle(tab.id == view.id ? Palette.fg : Palette.t300)
                        .padding(.horizontal, 10)
                        .frame(height: 32)
                        .background(RoundedRectangle(cornerRadius: 6).fill(tab.id == view.id ? Palette.bg80 : .clear))
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(tab.id == view.id ? .isSelected : [])
                }
                Text(CbaseRules.countLabel(shown: shown, total: total))
                    .textStyle(TextStyle(size: 12, tabular: true)).foregroundStyle(Palette.t300).padding(.horizontal, 6)
                    .frame(minHeight: 44)
                toolButton(.filter, "Filter", badge: filterCount > 0 ? filterCount : nil) {
                    sheets.present { BaseFilterSheet(properties: properties, columns: CbaseRules.columns(view, properties)) { add(filter: $0, to: view) } }
                }
                toolButton(.arrowUpDown, "Sort") { sheets.present { sortSheet(view, properties: properties) } }
                toolButton(.slidersHorizontal, "Properties") { sheets.present { propertiesSheet(view, properties: properties) } }
                toolButton(.plus, "New", isNew: true) { newNote(definition, view: view, properties: properties) }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
    }

    private func toolButton(_ icon: LucideName, _ title: String, badge: Int? = nil, isNew: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Icon(icon, size: 15)
                Text(title).textStyle(TextStyle(size: 13))
                if let badge {
                    Text("\(badge)").textStyle(TextStyle(size: 11, tabular: true)).foregroundStyle(Palette.primary)
                        .padding(.horizontal, 6).background(Capsule().fill(Palette.primary.opacity(0.1)))
                }
            }
            .foregroundStyle(isNew ? Palette.primary : Palette.t200)
            .padding(.horizontal, 8)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
    }

    @ViewBuilder private func chips(_ definition: CbaseDefinition, view: CbaseView, properties: [String: CbaseProperty]) -> some View {
        let defined = (definition.filters ?? []).enumerated().map { ($0.offset, $0.element, true) }
        let own = (view.filters ?? []).enumerated().map { ($0.offset, $0.element, false) }
        let all = defined + own
        if !all.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(all.enumerated()), id: \.offset) { _, entry in
                        let (index, filter, isDefined) = entry
                        HStack(spacing: 2) {
                            Text(CbaseRules.summary(filter, properties)).textStyle(TextStyle(size: 12)).foregroundStyle(Palette.t200).lineLimit(1)
                            if isDefined {
                                Text("base").textStyle(TextStyle(size: 10)).foregroundStyle(Palette.t200.opacity(0.6)).padding(.trailing, 4)
                            } else {
                                Button { remove(filterAt: index, from: view) } label: {
                                    Icon(.x, size: 12).frame(width: 28, height: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .foregroundStyle(Palette.t300)
                                .accessibilityLabel("Remove filter")
                            }
                        }
                        .padding(.leading, 8)
                        .frame(height: 28)
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: isDefined ? [3, 2] : [])))
                    }
                }
                .padding(.horizontal, 12)
            }
            .frame(height: 44)
        }
    }

    private func table(rows: [CbaseRow], columns: [String], properties: [String: CbaseProperty]) -> some View {
        let first = columns.first
        let rest = Array(columns.dropFirst())
        return ScrollView([.horizontal, .vertical]) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(columns, id: \.self) { column in
                        Text(CbaseRules.columnLabel(column, properties))
                            .textStyle(TextStyle(size: 12.5, weight: 500)).foregroundStyle(Palette.t300).lineLimit(1)
                            .padding(.horizontal, 12).frame(height: 40, alignment: .leading)
                            .frame(maxWidth: .infinity, alignment: properties[column]?.type == .number ? .trailing : .leading)
                    }
                }
                separator(Color(hex: 0xDADDE3), columns: columns.count)
                if rows.isEmpty {
                    GridRow {
                        Text("No matching files").textStyle(TextStyle(size: 13.5)).foregroundStyle(Palette.t300)
                            .frame(maxWidth: .infinity, minHeight: 80).gridCellColumns(max(1, columns.count))
                    }
                }
                ForEach(rows) { row in
                    GridRow {
                        if let first { openCell(row, column: first, properties: properties) }
                        ForEach(rest, id: \.self) { column in valueCell(row, column: column, properties: properties) }
                    }
                    separator(Color(hex: 0xECEEF1), columns: columns.count)
                }
            }
            .padding(.bottom, 30)
        }
        .defaultScrollAnchor(.topLeading)
        .scrollDismissesKeyboard(.interactively)
    }

    private func separator(_ color: Color, columns: Int) -> some View {
        GridRow {
            Rectangle().fill(color).frame(height: 1).gridCellColumns(max(1, columns))
        }
    }

    /// The first column opens the row's note (`resolveRowTitle`).
    private func openCell(_ row: CbaseRow, column: String, properties: [String: CbaseProperty]) -> some View {
        let value = CbaseRules.value(row, column, properties)
        let title = value?.stringValue.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? row.displayName
        return Button {
            router.push(.panel(.file(FileLocation(projectID: location.projectID, sessionID: location.sessionID, path: row.filePath))))
        } label: {
            HStack(spacing: 6) {
                Icon(.fileText, size: 14).foregroundStyle(Palette.t300)
                Text(title).textStyle(TextStyle(size: 13.5, weight: 500)).foregroundStyle(Palette.fg).lineLimit(1)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private func valueCell(_ row: CbaseRow, column: String, properties: [String: CbaseProperty]) -> some View {
        let property = properties[column]
        let value = CbaseRules.value(row, column, properties)
        let editable = CbaseRules.isEditable(property) && location.sessionID == nil
        let key = "\(row.filePath)\u{0}\(property?.key ?? column)"
        switch property?.type {
        case .checkbox?:
            let on = value?.boolValue == true
            Button { if editable, let property { set(row, property, .bool(!on)) } } label: {
                CheckboxMark(isOn: on)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 1)
            .accessibilityLabel(property?.key ?? column)
            .accessibilityValue(on ? "true" : "false")
        case .select?:
            Text(CbaseRules.format(value)).textStyle(TextStyle(size: 12)).foregroundStyle(Palette.t200)
                .padding(.horizontal, 8).padding(.vertical, 1).background(Capsule().fill(Palette.bg80))
                .padding(.horizontal, 12).frame(minHeight: 44)
        case .number?:
            if editingCell == key {
                TextField("", text: $numberDraft)
                    .keyboardType(.decimalPad)
                    .textStyle(TextStyle(size: 13.5, tabular: true))
                    .multilineTextAlignment(.trailing)
                    .focused($numberFocused)
                    .padding(.horizontal, 6)
                    .frame(width: 64, height: 32)
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.primary))
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .trailing)
                    .onAppear { numberFocused = true }
                    .onSubmit { commitNumber(row, property) }
                    .onChange(of: numberFocused) { _, focused in if !focused { commitNumber(row, property) } }
            } else {
                Button {
                    guard editable else { return }
                    numberDraft = value.map { CbaseRules.format($0) == "—" ? "" : CbaseRules.format($0) } ?? ""
                    editingCell = key
                } label: {
                    Text(value == nil ? "" : CbaseRules.format(value)).textStyle(TextStyle(size: 13.5, tabular: true)).foregroundStyle(Palette.t200)
                        .frame(minWidth: 44, minHeight: 44, alignment: .trailing)
                        .padding(.horizontal, 12)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(property?.key ?? column)
            }
        default:
            Text(CbaseRules.format(value)).textStyle(TextStyle(size: 13.5)).foregroundStyle(Palette.t200).lineLimit(1)
                .padding(.horizontal, 12).frame(minHeight: 44)
        }
    }

    // MARK: Sheets

    private func sortSheet(_ view: CbaseView, properties: [String: CbaseProperty]) -> some View {
        let active = view.sort?.first
        let sortable = CbaseRules.columns(view, properties).filter { properties[$0] != nil }
        return VStack(spacing: 0) {
            SheetHeader(title: "Sort")
            ScrollView {
                SheetMenu {
                    MenuItem(title: "Query order", checked: active == nil) { persist(view) { $0.sort = nil } }
                    ForEach(sortable, id: \.self) { column in
                        let labels = CbaseRules.sortLabels(properties[column])
                        let label = CbaseRules.columnLabel(column, properties)
                        MenuItem(title: "\(label) · \(labels.0)", checked: active == CbaseSort(by: column, dir: .asc)) {
                            persist(view) { $0.sort = [CbaseSort(by: column, dir: .asc)] }
                        }
                        MenuItem(title: "\(label) · \(labels.1)", checked: active == CbaseSort(by: column, dir: .desc)) {
                            persist(view) { $0.sort = [CbaseSort(by: column, dir: .desc)] }
                        }
                    }
                }
            }
            .frame(maxHeight: 520)
        }
    }

    private func propertiesSheet(_ view: CbaseView, properties: [String: CbaseProperty]) -> some View {
        BasePropertiesSheet(visible: CbaseRules.columns(view, properties), properties: properties) { columns in
            persist(view) { $0.table = CbaseTableView(columns: columns).keeping(widthsOf: $0.table) }
        }
    }

    // MARK: Changes

    private func add(filter: CbaseFilterCondition, to view: CbaseView) {
        persist(view) { $0.filters = ($0.filters ?? []) + [.condition(filter)] }
    }

    private func remove(filterAt index: Int, from view: CbaseView) {
        persist(view) { view in
            guard var filters = view.filters, filters.indices.contains(index) else { return }
            filters.remove(at: index)
            view.filters = filters.isEmpty ? nil : filters
        }
    }

    /// Writes the view change to the `.cbase` file and shows the refreshed result.
    private func persist(_ view: CbaseView, _ change: @escaping (inout CbaseView) -> Void) {
        sheets.dismiss()
        guard var definition = base?.definition, let index = definition.views.firstIndex(where: { $0.id == view.id }) else { return }
        change(&definition.views[index])
        let properties = base?.properties ?? definition.properties
        Task {
            do {
                let persisted = try await services.editor.persistBase(projectID: location.projectID, path: location.path, definition: definition,
                                                                      properties: properties, viewID: view.id)
                base = persisted.document
            } catch let error as EditorError {
                toasts.show(error.message)
            } catch {
                reportFailure(RouteFailure(error))
            }
        }
    }

    private func set(_ row: CbaseRow, _ property: CbaseProperty, _ value: JSONValue) {
        let key = "\(row.filePath)\u{0}\(property.key)"
        overlay[key] = value
        Task {
            do {
                try await services.editor.setBaseProperty(projectID: location.projectID, filePath: row.filePath, key: property.key, value: value)
                await query()
            } catch {
                overlay[key] = nil
                toasts.show("Failed to update property", description: (error as? EditorError)?.message ?? error.localizedDescription)
            }
        }
    }

    private func commitNumber(_ row: CbaseRow, _ property: CbaseProperty?) {
        guard editingCell != nil, let property else { return }
        editingCell = nil
        let text = numberDraft.trimmingCharacters(in: .whitespaces)
        let value: JSONValue = Double(text).map(JSONValue.number) ?? (text.isEmpty ? .string("") : .string(text))
        if CbaseRules.compare(row.values[property.key], value) != .orderedSame || row.values[property.key] == nil { set(row, property, value) }
    }

    private func newNote(_ definition: CbaseDefinition, view: CbaseView, properties: [String: CbaseProperty]) {
        let folder = definition.template?.folder ?? CbaseRules.datasetFolder(definition.dataset)
        let existing = Set((base?.views ?? []).flatMap { $0.rows.map(\.filePath) })
        let path = CbaseRules.nextUntitledPath(folder: folder, existing: existing)
        let content = CbaseRules.newNoteContent(view, properties) + (definition.template?.body ?? "")
        Task {
            do {
                _ = try await services.editor.write(path, content: content, in: .project(id: location.projectID))
                router.push(.panel(.file(FileLocation(projectID: location.projectID, sessionID: nil, path: path))))
            } catch {
                toasts.show("Failed to create note", description: (error as? EditorError)?.message ?? error.localizedDescription)
            }
        }
    }

    private func applyOverlay(_ row: CbaseRow) -> CbaseRow {
        guard !overlay.isEmpty else { return row }
        var row = row
        for (key, value) in overlay {
            let parts = key.split(separator: "\u{0}", maxSplits: 1).map(String.init)
            guard parts.count == 2, parts[0] == row.filePath else { continue }
            row.values[parts[1]] = value
        }
        return row
    }

    /// Drops optimistic values the re-query now shows.
    private func settleOverlay(_ result: CbaseDocument) {
        let rows = result.views.flatMap(\.rows)
        overlay = overlay.filter { key, value in
            let parts = key.split(separator: "\u{0}", maxSplits: 1).map(String.init)
            guard parts.count == 2, let row = rows.first(where: { $0.filePath == parts[0] }) else { return false }
            return CbaseRules.compare(row.values[parts[1]], value) != .orderedSame
        }
    }
}

private extension CbaseTableView {
    /// The new column list keeps the widths the desktop stored.
    func keeping(widthsOf previous: CbaseTableView?) -> CbaseTableView {
        var table = self
        table.column_widths = previous?.column_widths
        table.row_height = previous?.row_height
        return table
    }
}

/// Add filter (the desktop's filter popover): property, operator, value.
private struct BaseFilterSheet: View {
    let properties: [String: CbaseProperty]
    let columns: [String]
    let onAdd: (CbaseFilterCondition) -> Void
    @State private var propertyID = ""
    @State private var op = CbaseFilterOperator.contains
    @State private var value = ""

    var body: some View {
        let property = properties[propertyID]
        VStack(alignment: .leading, spacing: 0) {
            SheetHeader(title: "Add filter")
            VStack(alignment: .leading, spacing: 8) {
                Text("Saved to this view in the .cbase file.").textStyle(TextStyle(size: 12.5)).foregroundStyle(Palette.t300)
                picker(propertyID.isEmpty ? "Property" : CbaseRules.columnLabel(propertyID, properties), placeholder: propertyID.isEmpty) {
                    ForEach(choices, id: \.self) { id in
                        Button(CbaseRules.columnLabel(id, properties)) {
                            propertyID = id
                            op = CbaseRules.defaultOperator(properties[id])
                            value = properties[id]?.type == .checkbox ? "true" : ""
                        }
                    }
                }
                picker(CbaseRules.label(op), placeholder: false) {
                    ForEach(CbaseRules.allowedOperators(property), id: \.self) { candidate in
                        Button(CbaseRules.label(candidate)) { op = candidate }
                    }
                }
                if CbaseRules.needsValue(op) {
                    if property?.type == .checkbox {
                        picker(value, placeholder: false) {
                            Button("true") { value = "true" }
                            Button("false") { value = "false" }
                        }
                    } else if property?.type == .select, let options = property?.options, !options.isEmpty {
                        picker(value.isEmpty ? "Value" : value, placeholder: value.isEmpty) {
                            ForEach(options, id: \.self) { option in Button(option) { value = option } }
                        }
                    } else {
                        TextField("", text: $value, prompt: Text("Value").foregroundStyle(Palette.t300))
                            .textStyle(TextStyle(size: 15))
                            .keyboardType(property?.type == .number ? .decimalPad : .default)
                            .textInputAutocapitalization(.never)
                            .padding(.horizontal, 12)
                            .frame(height: 44)
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.border))
                    }
                }
                Button {
                    onAdd(CbaseFilterCondition(property: propertyID, op: op,
                                               value: CbaseRules.needsValue(op) ? CbaseRules.typedFilterValue(value, property) : nil))
                } label: {
                    Text("Add filter").textStyle(.bigButton).foregroundStyle(Palette.primary)
                        .frame(maxWidth: .infinity).frame(height: 50)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Palette.primary.opacity(0.1)))
                        .opacity(propertyID.isEmpty ? 0.5 : 1)
                }
                .buttonStyle(.plain)
                .disabled(propertyID.isEmpty)
            }
            .padding(.horizontal, 16)
        }
    }

    private var choices: [String] {
        let listed = columns.filter { properties[$0] != nil }
        return listed + properties.keys.filter { !listed.contains($0) }.sorted()
    }

    private func picker<Items: View>(_ title: String, placeholder: Bool, @ViewBuilder items: () -> Items) -> some View {
        Menu {
            items()
        } label: {
            HStack {
                Text(title).textStyle(TextStyle(size: 15)).foregroundStyle(placeholder ? Palette.t300 : Palette.fg)
                Spacer(minLength: 8)
                Icon(.chevronDown, size: 16).foregroundStyle(Palette.t300)
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.border))
            .contentShape(Rectangle())
        }
    }
}

/// Properties (the desktop's columns menu): visible columns, then hidden ones; the last visible stays.
private struct BasePropertiesSheet: View {
    let visible: [String]
    let properties: [String: CbaseProperty]
    let onChange: ([String]) -> Void

    var body: some View {
        let hidden = properties.keys.filter { !visible.contains($0) }.sorted()
        VStack(spacing: 0) {
            SheetHeader(title: "Properties")
            ScrollView {
                SheetMenu {
                    MenuLabel(text: "Visible columns")
                    ForEach(visible, id: \.self) { column in
                        MenuItem(title: CbaseRules.columnLabel(column, properties), checked: true, isEnabled: visible.count > 1) {
                            onChange(visible.filter { $0 != column })
                        }
                    }
                    if !hidden.isEmpty {
                        MenuLabel(text: "Hidden")
                        ForEach(hidden, id: \.self) { column in
                            MenuItem(title: CbaseRules.columnLabel(column, properties)) { onChange(visible + [column]) }
                        }
                    }
                }
            }
            .frame(maxHeight: 520)
        }
    }
}
