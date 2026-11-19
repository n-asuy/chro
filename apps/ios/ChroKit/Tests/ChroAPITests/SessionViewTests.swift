import Foundation
import Testing
@testable import ChroAPI

struct SessionViewTests {
    static let json = #"""
    {"id":"3753a0a8-2ba0-4b86-bb95-8bd2992f597c","slug":"7hdSeWrD","title":"Add removeStock to stock module",
     "project":{"id":"97984c0f-7106-4b8d-8aa2-689412a99638","slug":"97984c0f","name":"inventory-service","path":"/repo"},
     "state":"awaiting_input","status":"in_progress","agent":"CLAUDE_CODE","branch":"ch/e7a6-add-removestock-to-stock",
     "worktree":"/wt","note":null,"summary":"I applied two of the review's findings.",
     "turn":{"id":"6dd04da8-b32a-4139-8a86-fe1e19ddfc2a","slug":"xe4kxijT","status":"running","started_at":"2026-11-14T05:15:58.048114Z","completed_at":null},
     "queue":[{"id":"0b6c1d1e-0000-4000-8000-000000000001","prompt":"Then print the total.","created_at":"2026-11-14T05:16:00Z"}],
     "parent":null,"children":[{"id":"a5ff527f-c7b8-409c-9763-b9853d9c1526","slug":"7fjQIBX5","title":"Review removeStock"}],
     "created_at":"2026-11-14T03:33:08.359621Z","updated_at":"2026-11-14T05:15:58Z"}
    """#

    @Test func decodesEveryFieldTheServerSends() throws {
        let view = try APIDecoder.make().decode(SessionView.self, from: Data(Self.json.utf8))
        #expect(view.state == .awaitingInput)
        #expect(view.handle == "7hdSeWrD")
        #expect(view.queue.first?.prompt == "Then print the total.")
        #expect(view.children.first?.title == "Review removeStock")
        #expect(view.turn?.status == "running")
        // Fractional and whole-second RFC 3339 timestamps both parse.
        #expect(view.createdAt < view.updatedAt)
    }

    @Test func unknownSessionStatesAreKeptRatherThanRejected() throws {
        let json = Self.json.replacingOccurrences(of: "\"awaiting_input\"", with: "\"hibernating\"")
        let view = try APIDecoder.make().decode(SessionView.self, from: Data(json.utf8))
        #expect(view.state == .unknown("hibernating"))
    }

    @Test func newSessionFlattensTheAgentChoiceAndOmitsDefaults() throws {
        let body = NewSession(project: "path:/repo", prompt: "fix it", agent: AgentChoice(agent: "codex", effort: "high"))
        let object = try JSONSerialization.jsonObject(with: APIEncoder.make().encode(body)) as! [String: Any]
        #expect(object["agent"] as? String == "codex")
        #expect(object["effort"] as? String == "high")
        #expect(object["model"] == nil)
        #expect(object["refs"] == nil)
        #expect(object["start"] as? Bool == true)
    }

    @Test func respondCarriesAskUserQuestionAnswers() throws {
        let body = Respond(decision: .approve, answers: ["Which restock policy?": "Weekly batch"])
        let object = try JSONSerialization.jsonObject(with: APIEncoder.make().encode(body)) as! [String: Any]
        #expect(object["decision"] as? String == "approve")
        #expect((object["answers"] as? [String: String])?["Which restock policy?"] == "Weekly batch")
        #expect(object["reason"] == nil)
    }
}
