import ChroDomain
import Testing

@Suite struct CSVTableTests {
    static let levels = "sku,on_hand,reserved,reorder_point\nA1,5,1,4\nB2,1,0,3\nC3,12,4,6"

    @Test func parsesTheCapturedFile() {
        let table = CSVTable.parse(Self.levels)
        #expect(table.rows.count == 4)
        #expect(table.columnCount == 4)
        #expect(table.rows[2] == ["B2", "1", "0", "3"])
        #expect(table.serialized() == Self.levels)
    }

    @Test func quotedFieldsAndLineEndingsRoundTrip() {
        let text = "a,\"b,c\",\"say \"\"hi\"\"\"\r\n1,\"x\ny\",3\r\n"
        let table = CSVTable.parse(text)
        #expect(table.rows == [["a", "b,c", "say \"hi\""], ["1", "x\ny", "3"]])
        #expect(table.serialized() == text)
    }

    @Test func raggedRowsArePaddedAndBOMDropped() {
        let table = CSVTable.parse("\u{FEFF}a,b\n1")
        #expect(table.rows == [["a", "b"], ["1", ""]])
    }

    @Test func tabSeparatedByExtension() {
        #expect(CSVTable.delimiter(forPath: "x.TSV") == "\t")
        #expect(CSVTable.parse("a\tb", delimiter: "\t").rows == [["a", "b"]])
    }

    @Test func editingOperations() {
        var table = CSVTable.parse("h1,h2\na,b")
        table.set(row: 1, column: 0, to: "z")
        #expect(table.rows[1] == ["z", "b"])
        table.insertRow(at: 2)
        #expect(table.rows.count == 3)
        table.insertColumn(at: 1)
        #expect(table.rows[0] == ["h1", "", "h2"])
        table.deleteColumn(1)
        table.deleteRow(2)
        #expect(table.serialized() == "h1,h2\nz,b")
    }

    @Test func emptyTextIsOneEmptyCell() {
        #expect(CSVTable.parse("").rows == [[""]])
    }
}
