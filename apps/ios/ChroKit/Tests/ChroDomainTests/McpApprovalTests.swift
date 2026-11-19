import ChroAPI
import ChroDomain
import XCTest

/// utils/mcp-approval-mapping.ts and components/mcp-tool-approval.tsx.
final class McpApprovalTests: XCTestCase {
    private let input: JSONValue = .object([
        "server": .string("github"), "title": .string("GitHub"), "risk_level": .string("elevated"),
        "message": .string("Allow the github MCP server to run create_pull_request?"),
        "params": .array([.object(["label": .string("repo"), "value": .string("inventory-service")]), .object(["label": .string("bad")])]),
        "options": .array([.string("allow"), .string("allow_session"), .string("allow_always"), .string("deny"), .string("bogus")]),
    ])

    func testParsesAUsablePrompt() throws {
        let prompt = try XCTUnwrap(McpApprovalPrompt.parse(input))
        XCTAssertEqual(prompt.server, "github")
        XCTAssertEqual(prompt.headerLabel, "GitHub · github")
        XCTAssertTrue(prompt.isOutsideSandbox)
        XCTAssertEqual(prompt.params, [.init(label: "repo", value: "inventory-service")])
        XCTAssertEqual(prompt.options, [.allow, .allowSession, .allowAlways, .deny])
    }

    func testRejectsPromptsThatCannotBeAnswered() {
        XCTAssertNil(McpApprovalPrompt.parse(nil))
        XCTAssertNil(McpApprovalPrompt.parse(.object(["server": .string("s"), "message": .string("m"), "options": .array([])])))
        XCTAssertNil(McpApprovalPrompt.parse(.object(["message": .string("m"), "options": .array([.string("allow")])])))
    }

    func testHeaderWithoutTitleAndLowRisk() throws {
        let prompt = try XCTUnwrap(McpApprovalPrompt.parse(.object([
            "server": .string("files"), "title": .string(""), "risk_level": .string("low"), "message": .string("m"), "options": .array([.string("deny")]),
        ])))
        XCTAssertEqual(prompt.headerLabel, "files")
        XCTAssertFalse(prompt.isOutsideSandbox)
    }

    func testDecisionLabelsAndResponse() {
        XCTAssertEqual(McpDecision.allow.title, "Allow")
        XCTAssertEqual(McpDecision.allow.detail, "Just this once")
        XCTAssertEqual(McpDecision.allowSession.title, "Allow for this session")
        XCTAssertNil(McpDecision.allowSession.detail)
        XCTAssertEqual(McpDecision.allowAlways.detail, "Stop asking for this tool")
        XCTAssertTrue(McpDecision.deny.isMuted)
        XCTAssertTrue(McpDecision.allowAlways.approves)
        XCTAssertFalse(McpDecision.deny.approves)
        XCTAssertEqual(McpDecision.allowSession.answers, ["decision": "allow_session"])
    }

    func testMultiLineParameterValues() {
        XCTAssertTrue(McpApprovalPrompt.Param(label: "body", value: "a\nb").isMultiline)
        XCTAssertFalse(McpApprovalPrompt.Param(label: "base", value: "main").isMultiline)
    }
}
