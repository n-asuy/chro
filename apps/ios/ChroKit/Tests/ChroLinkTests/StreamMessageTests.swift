import ChroAPI
import Foundation
import Testing
@testable import ChroLink

/// `/streams/*` messages (LogEntry) and the JSON Patch the task streams send.
struct StreamMessageTests {
    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    @Test func entriesDecodeByType() throws {
        #expect(try StreamMessage(Data("{\"type\":\"json_patch\",\"payload\":[{\"op\":\"remove\",\"path\":\"/tasks/a\"}]}".utf8))
            == .patch([try json("{\"op\":\"remove\",\"path\":\"/tasks/a\"}")]))
        #expect(try StreamMessage(Data("{\"type\":\"finished\"}".utf8)) == .finished)
        #expect(try StreamMessage(Data("{\"error\":\"stream lagged\"}".utf8)) == .failure("stream lagged"))
        #expect(try StreamMessage(Data("{\"type\":\"stdout\",\"payload\":\"hi\"}".utf8)) == .other(type: "stdout", payload: .string("hi")))
        #expect(throws: LinkError.self) { try StreamMessage(Data("[1]".utf8)) }
    }

    @Test func numbersStayNumbersAndBooleansStayBooleans() throws {
        #expect(try json("{\"n\":1,\"z\":0,\"b\":true}") == .object(["n": .number(1), "z": .number(0), "b": .bool(true)]))
    }

    @Test func snapshotThenAddReplaceRemove() throws {
        var document = JSONValue.object([:])
        try JSONPatch.apply([try json("{\"op\":\"replace\",\"path\":\"/tasks\",\"value\":{\"a\":{\"title\":\"A\"}}}")], to: &document)
        #expect(document == (try json("{\"tasks\":{\"a\":{\"title\":\"A\"}}}")))
        try JSONPatch.apply([
            try json("{\"op\":\"add\",\"path\":\"/tasks/b\",\"value\":{\"title\":\"B\"}}"),
            try json("{\"op\":\"replace\",\"path\":\"/tasks/a/title\",\"value\":\"A2\"}"),
            try json("{\"op\":\"remove\",\"path\":\"/tasks/b\"}"),
        ], to: &document)
        #expect(document == (try json("{\"tasks\":{\"a\":{\"title\":\"A2\"}}}")))
    }

    @Test func pointersUnescape() throws {
        #expect(try JSONPatch.pointer("/tasks/a~1b~0c") == ["tasks", "a/b~c"])
        #expect(try JSONPatch.pointer("") == [])
        #expect(throws: LinkError.self) { try JSONPatch.pointer("tasks") }
    }

    @Test func arrays() throws {
        var document = try json("{\"l\":[1,3]}")
        try JSONPatch.apply([
            try json("{\"op\":\"add\",\"path\":\"/l/1\",\"value\":2}"),
            try json("{\"op\":\"add\",\"path\":\"/l/-\",\"value\":4}"),
            try json("{\"op\":\"remove\",\"path\":\"/l/0\"}"),
        ], to: &document)
        #expect(document == (try json("{\"l\":[2,3,4]}")))
    }

    @Test func invalidOperationsThrow() throws {
        var document = try json("{\"tasks\":{}}")
        #expect(throws: LinkError.self) { try JSONPatch.apply([try json("{\"op\":\"remove\",\"path\":\"/tasks/x\"}")], to: &document) }
        #expect(throws: LinkError.self) { try JSONPatch.apply([try json("{\"op\":\"move\",\"from\":\"/a\",\"path\":\"/b\"}")], to: &document) }
        #expect(throws: LinkError.self) { try JSONPatch.apply([try json("{\"op\":\"replace\",\"path\":\"/missing/x\",\"value\":1}")], to: &document) }
    }
}
