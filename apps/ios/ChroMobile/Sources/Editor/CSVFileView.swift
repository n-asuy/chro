import ChroDomain
import ChroServices
import SwiftUI

/// The spreadsheet editor of `.csv` / `.tsv` (csv-editor.tsx, the mock's
/// `csvEditor`): a sticky header row, tap a cell to select it, tap it again
/// to edit; the More sheet adds and deletes rows and columns. Edits save
/// through the text document.
struct CSVFileView: View {
    let location: FileLocation
    let document: TextDocument
    @Environment(SheetPresenter.self) private var sheets
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// Row 0 is the header; the first data row is selected at first.
    @State private var cell = CSVCell(row: 1, column: 0)
    @State private var editing = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    /// Columns size to their text (12pt padding each side) and share out a wider screen.
    private func columnWidths(_ table: CSVTable, available: CGFloat) -> [CGFloat] {
        guard table.columnCount > 0 else { return [] }
        let header = TextStyle(size: 13, weight: 500).uiFont(dynamicTypeSize), body = TextStyle(size: 13).uiFont(dynamicTypeSize)
        let share = (available / CGFloat(table.columnCount)).rounded(.down)
        return (0..<table.columnCount).map { column in
            let widest = table.rows.enumerated().map { index, row in
                (row[column] as NSString).size(withAttributes: [.font: index == 0 ? header : body]).width
            }.max() ?? 0
            return max(share, min(320, widest.rounded(.up) + 24))
        }
    }

    var body: some View {
        let table = CSVTable.parse(document.text, delimiter: CSVTable.delimiter(forPath: location.path))
        VStack(spacing: 0) {
            FileNavBar(path: location.path) {
                IconButton(icon: .ellipsis, size: 20, label: "More") { sheets.present { menu(table) } }
            }
            TextDocumentGate(document: document) {
                VStack(spacing: 0) {
                    grid(table)
                    footer(table)
                }
            }
        }
    }

    private func grid(_ table: CSVTable) -> some View {
        GeometryReader { proxy in
            grid(table, widths: columnWidths(table, available: proxy.size.width))
        }
    }

    private func grid(_ table: CSVTable, widths: [CGFloat]) -> some View {
        ScrollView([.horizontal, .vertical]) {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                Section {
                    ForEach(1..<max(1, table.rows.count), id: \.self) { row in
                        HStack(spacing: 0) {
                            ForEach(0..<table.columnCount, id: \.self) { column in
                                dataCell(table, row: row, column: column, width: widths[column])
                            }
                        }
                    }
                } header: {
                    HStack(spacing: 0) {
                        ForEach(0..<table.columnCount, id: \.self) { column in
                            Text(table.rows.first?[column] ?? "")
                                .textStyle(TextStyle(size: 13, weight: 500))
                                .foregroundStyle(Palette.t300)
                                .lineLimit(1)
                                .padding(.horizontal, 12)
                                .frame(width: widths[column], height: 44, alignment: .leading)
                                .background(Palette.bg90)
                                .overlay(alignment: .bottom) { Rectangle().fill(Color(hex: 0xDADDE3)).frame(height: 1) }
                                .overlay(alignment: .trailing) { Rectangle().fill(Color(hex: 0xDADDE3).opacity(0.5)).frame(width: 1) }
                        }
                    }
                }
            }
        }
        .defaultScrollAnchor(.topLeading)
        .scrollDismissesKeyboard(.interactively)
    }

    private func dataCell(_ table: CSVTable, row: Int, column: Int, width: CGFloat) -> some View {
        let isActive = cell == CSVCell(row: row, column: column)
        return Group {
            if isActive && editing {
                TextField("", text: $draft)
                    .textStyle(TextStyle(size: 13))
                    .foregroundStyle(Palette.fg)
                    .focused($focused)
                    .submitLabel(.next)
                    .onSubmit { commit(table, moveDown: true) }
                    .onChange(of: focused) { _, isFocused in if !isFocused { commit(table, moveDown: false) } }
                    .onAppear { focused = true }
            } else {
                Text(table.rows[row][column]).textStyle(TextStyle(size: 13)).foregroundStyle(Palette.fg).lineLimit(1)
            }
        }
        .padding(.horizontal, 12)
        .frame(width: width, height: 40, alignment: .leading)
        .overlay(alignment: .bottom) { Rectangle().fill(Color(hex: 0xDADDE3)).frame(height: 1) }
        .overlay(alignment: .trailing) { Rectangle().fill(Color(hex: 0xDADDE3).opacity(0.5)).frame(width: 1) }
        .overlay { if isActive { Rectangle().strokeBorder(Color(hex: 0x299AD6), lineWidth: 2) } }
        .contentShape(Rectangle())
        .onTapGesture { tap(table, row: row, column: column) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(table.rows.first?[column] ?? ""): \(table.rows[row][column])")
        .accessibilityAddTraits(isActive ? [.isSelected, .isButton] : .isButton)
    }

    private func footer(_ table: CSVTable) -> some View {
        let rows = table.dataRowCount, columns = table.columnCount
        return HStack(spacing: 16) {
            Text("\(rows) \(rows == 1 ? "row" : "rows")")
            Text("\(columns) \(columns == 1 ? "column" : "columns")")
            Text("R\(cell.row), C\(cell.column + 1)")
            Spacer(minLength: 0)
        }
        .textStyle(TextStyle(size: 12.5, tabular: true))
        .foregroundStyle(Palette.t300)
        .padding(.horizontal, 16)
        .frame(height: 40)
        .background(Palette.bg90)
        .overlay(alignment: .top) { Rectangle().fill(Color(hex: 0xDADDE3)).frame(height: 1) }
    }

    private func tap(_ table: CSVTable, row: Int, column: Int) {
        guard document.isEditable else { cell = CSVCell(row: row, column: column); return }
        if editing { commit(table, moveDown: false) }
        if cell == CSVCell(row: row, column: column) {
            draft = table.rows[row][column]
            editing = true
        } else {
            cell = CSVCell(row: row, column: column)
        }
    }

    private func commit(_ table: CSVTable, moveDown: Bool) {
        guard editing else { return }
        editing = false
        var updated = table
        if updated.rows.indices.contains(cell.row), updated.rows[cell.row][cell.column] != draft {
            updated.set(row: cell.row, column: cell.column, to: draft)
            document.edit(updated.serialized())
        }
        if moveDown { cell.row = min(cell.row + 1, max(1, updated.rows.count - 1)) }
    }

    /// The More sheet (csv-editor.tsx toolbar): `+ Row`, `+ Column`, and the deletes.
    private func menu(_ table: CSVTable) -> some View {
        VStack(spacing: 0) {
            SheetHeader(title: "")
            SheetMenu {
                MenuItem(icon: .plus, title: "+ Row", isEnabled: document.isEditable) { operate { $0.insertRow(at: cell.row + 1) } }
                MenuItem(icon: .plus, title: "+ Column", isEnabled: document.isEditable) { operate { $0.insertColumn(at: cell.column + 1) } }
                MenuItem(icon: .trash, title: "Row", isEnabled: document.isEditable && table.rows.count > 2) { operate { $0.deleteRow(cell.row) } }
                    .accessibilityLabel("Delete current row")
                MenuItem(icon: .trash, title: "Column", isEnabled: document.isEditable && table.columnCount > 1) { operate { $0.deleteColumn(cell.column) } }
                    .accessibilityLabel("Delete current column")
            }
        }
    }

    private func operate(_ change: (inout CSVTable) -> Void) {
        var table = CSVTable.parse(document.text, delimiter: CSVTable.delimiter(forPath: location.path))
        change(&table)
        cell = CSVCell(row: min(max(1, cell.row), max(1, table.rows.count - 1)), column: min(cell.column, table.columnCount - 1))
        document.edit(table.serialized())
        sheets.dismiss()
    }
}

struct CSVCell: Equatable {
    var row: Int
    var column: Int
}
