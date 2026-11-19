import ChroAPI
import Testing
@testable import ChroDomain

/// The computer hides MCP credentials from a phone as `__chro_hidden__` and puts
/// them back on save only where the phone kept a hidden string as it was (at its
/// place, or moved within the same object or array). The phone refuses the rest
/// before saving, with the computer's text (architecture doc §4.1).
struct McpHiddenValuesTests {
    static let hidden = McpHiddenValues.placeholder

    static var loaded: JSONValue {
        .object([
            "github": .object([
                "command": .string("npx"),
                "args": .array([.string("-y"), .string("server-github"), .string("--token=\(hidden)")]),
                "env": .object(["GITHUB_TOKEN": .string(hidden), "LOG_LEVEL": .string("info")]),
            ]),
            "remote": .object(["url": .string("https://bot:\(hidden)@host/sse?api_key=\(hidden)&team=core")]),
        ])
    }

    private func edited(_ change: (inout [String: JSONValue]) -> Void) -> JSONValue {
        guard case .object(var servers) = Self.loaded else { fatalError() }
        change(&servers)
        return .object(servers)
    }

    private static func set(_ servers: inout [String: JSONValue], _ server: String, _ key: String, _ value: JSONValue) {
        guard case .object(var members)? = servers[server] else { return }
        members[key] = value
        servers[server] = .object(members)
    }

    @Test func keptHiddenValuesAndUnrelatedEditsAreAccepted() {
        #expect(McpHiddenValues.problem(edited: Self.loaded, loaded: Self.loaded) == nil)
        let renamedLevel = edited { Self.set(&$0, "github", "env", .object(["GITHUB_TOKEN": .string(Self.hidden), "LOG_LEVEL": .string("debug")])) }
        #expect(McpHiddenValues.problem(edited: renamedLevel, loaded: Self.loaded) == nil)
    }

    @Test func replacingAWholeHiddenValueIsAccepted() {
        let replaced = edited { Self.set(&$0, "github", "env", .object(["GITHUB_TOKEN": .string("ghp_new"), "LOG_LEVEL": .string("info")])) }
        #expect(McpHiddenValues.problem(edited: replaced, loaded: Self.loaded) == nil)
    }

    @Test func aHiddenValueMovedWithinItsArrayOrObjectIsAccepted() {
        let inserted = edited {
            Self.set(&$0, "github", "args", .array([.string("--verbose"), .string("-y"), .string("server-github"), .string("--token=\(Self.hidden)")]))
        }
        #expect(McpHiddenValues.problem(edited: inserted, loaded: Self.loaded) == nil)
        let renamedKey = edited { Self.set(&$0, "github", "env", .object(["GH_TOKEN": .string(Self.hidden), "LOG_LEVEL": .string("info")])) }
        #expect(McpHiddenValues.problem(edited: renamedKey, loaded: Self.loaded) == nil)
    }

    @Test func editingAroundAHiddenPartIsRefusedWithTheComputersText() {
        let host = edited { Self.set(&$0, "remote", "url", .string("https://bot:\(Self.hidden)@other/sse?api_key=\(Self.hidden)&team=core")) }
        #expect(McpHiddenValues.problem(edited: host, loaded: Self.loaded)
            == "MCP server \"remote\" holds a hidden value that no longer matches the computer's configuration; edit hidden values on the computer, or replace the whole value")
    }

    @Test func aHiddenValueInAnotherPlaceOrServerIsRefused() {
        let elsewhere = edited { Self.set(&$0, "github", "command", .string(Self.hidden)) }
        #expect(McpHiddenValues.problem(edited: elsewhere, loaded: Self.loaded) != nil)
        let renamedServer = edited { $0["gh"] = $0.removeValue(forKey: "github") }
        #expect(McpHiddenValues.problem(edited: renamedServer, loaded: Self.loaded)?.contains("\"gh\"") == true)
        let typed = edited { $0["new"] = .object(["env": .object(["KEY": .string(Self.hidden)])]) }
        #expect(McpHiddenValues.problem(edited: typed, loaded: Self.loaded) != nil)
    }
}
