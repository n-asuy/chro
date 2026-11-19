import ChroDomain
import Testing
@testable import ChroServices

/// A session the phone just started opens on its prompt, not on an empty
/// spinner, until the conversation's streams carry the prompt themselves.
struct StartedConversationTests {
    let started = SessionConversation.started(sessionID: "s1", prompt: "Reply with pong", runtime: RuntimeChoice(agent: .claudeCode))

    private func prompts(_ conversation: SessionConversation) -> [String] {
        conversation.entries.compactMap { if case .userMessage(let text) = $0.kind { text } else { nil } }
    }

    @Test func itShowsThePromptBeforeAnythingLoads() {
        #expect(prompts(started) == ["Reply with pong"])
        #expect(started.entries.last?.kind == .loading(""), "the desktop's pending submission is working from the first frame")
        #expect(!started.isLoaded)
        #expect(started.composerSeed == nil)
    }

    @Test func theFeedsEmptyFirstValueKeepsThePrompt() {
        let empty = SessionConversation(sessionID: "s1", isLoaded: false, runtime: RuntimeChoice(agent: .claudeCode), hasRun: false)
        #expect(started.superseded(by: empty).entries.map(\.kind) == [.userMessage("Reply with pong"), .loading("")])
    }

    @Test func loadedRunsWithoutThePromptYetKeepItAndTakeTheRest() {
        let reply = ConversationEntry(id: "r1:stream-entry:1", runID: "r1", kind: .assistantMessage("po"))
        let loaded = SessionConversation(sessionID: "s1", entries: [reply], isLoaded: true, runtime: RuntimeChoice(agent: .claudeCode, model: "Haiku 5.5"), hasRun: true)
        let shown = started.superseded(by: loaded)
        #expect(prompts(shown) == ["Reply with pong"])
        #expect(shown.entries.last == reply, "the streams' own entries decide whether the run is working")
        #expect(shown.composerSeed == RuntimeChoice(agent: .claudeCode, model: "Haiku 5.5"))
    }

    @Test func theStreamsOwnPromptReplacesIt() {
        let own = ConversationEntry(id: "r1:synthetic-user-ts1", runID: "r1", kind: .userMessage("Reply with pong"))
        let loaded = SessionConversation(sessionID: "s1", entries: [own], isLoaded: true, runtime: RuntimeChoice(agent: .claudeCode), hasRun: true)
        let shown = started.superseded(by: started.superseded(by: loaded))
        #expect(shown == loaded)
        // Once replaced, later values are taken as they are.
        #expect(loaded.superseded(by: started) == started)
    }
}
