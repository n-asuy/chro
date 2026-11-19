import ChroAPI
import ChroDomain
import Foundation
import Testing

@Suite struct McpConfigDocumentTests {
    let claude = McpConfigShape(serversPath: ["mcpServers"], template: .object([:]))

    @Test func printsLikeTwoSpaceJSONStringifyWithSortedKeys() throws {
        let value = try JSONValue.parse(#"{"b":[1,"x",true,null],"a":{"z":{},"y":[]},"n":1.5}"#)
        #expect(value.prettyPrinted() == """
        {
          "a": {
            "y": [],
            "z": {}
          },
          "b": [
            1,
            "x",
            true,
            null
          ],
          "n": 1.5
        }
        """)
    }

    @Test func escapesStrings() throws {
        #expect(JSONValue.string("a\"b\\c\n/é").prettyPrinted() == #""a\"b\\c\n/é""#)
    }

    @Test func fullConfigNestsServersAtThePath() throws {
        let servers = try JSONValue.parse(#"{"freee":{"type":"http","url":"https://example.com/mcp"}}"#)
        let shape = McpConfigShape(serversPath: ["mcp", "servers"], template: .object(["keep": .bool(true)]))
        #expect(shape.fullConfig(servers: servers) == .object(["keep": .bool(true), "mcp": .object(["servers": servers])]))
        #expect(claude.fullConfig(servers: servers) == .object(["mcpServers": servers]))
    }

    @Test func validationMessagesMatchTheDesktop() {
        #expect(claude.validate("{") == .syntax)
        #expect(McpConfigShape.Problem.syntax.message == "The configuration JSON contains a syntax error.")
        #expect(claude.validate("[]") == .missingPath("mcpServers"))
        #expect(McpConfigShape.Problem.missingPath("mcpServers").message == "Missing required field at path: mcpServers")
        #expect(claude.validate(#"{"other":1}"#) == .serversNotObject)
        #expect(claude.validate(#"{"mcpServers":[]}"#) == .serversNotObject)
        #expect(McpConfigShape.Problem.serversNotObject.message == "Servers configuration must be an object")
        #expect(claude.validate(#"{"mcpServers":{}}"#) == nil)
    }

    @Test func extractsServers() throws {
        let servers = try claude.servers(fromText: #"{"mcpServers":{"a":{"command":"x"}},"other":1}"#)
        #expect(servers == .object(["a": .object(["command": .string("x")])]))
    }
}
