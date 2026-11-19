import Testing
@testable import ChroDomain

/// lib/agent-runtime-options.ts: efforts, speed and the composer's model pill.
struct RuntimeOptionsTests {
    let fable = ModelOption(label: "Fable 5.2", value: "fable", agent: .claudeCode, description: "", efforts: Effort.lowToMax, supportsFastSpeed: true)
    let sol = ModelOption(label: "GPT-6.1 Sol", value: "gpt-6.1-sol", agent: .codex, description: "", efforts: Effort.lowToUltra, supportsFastSpeed: false)

    @Test func effortLabelsAndWireNames() {
        #expect(Effort.allCases.map(\.rawValue) == ["low", "medium", "high", "xhigh", "max", "ultra"])
        #expect(Effort.allCases.map(\.label) == ["Low", "Medium", "High", "Extra High", "Max", "Ultra"])
    }

    @Test func unknownModelFallsBackPerAgent() {
        var choice = RuntimeChoice(agent: .claudeCode)
        #expect(choice.efforts(in: [fable]) == Effort.lowToMax)
        choice.agent = .pi
        #expect(choice.efforts(in: [fable]).isEmpty)
        #expect(choice.supportsFastSpeed(in: [fable]) == false)
    }

    @Test func pickingAModelSwitchesAgentAndDropsUnsupportedSettings() {
        var choice = RuntimeChoice(agent: .claudeCode, model: "Fable 5.2", effort: .high, speed: .fast)
        choice.pick(sol)
        #expect(choice.agent == .codex)
        #expect(choice.model == "GPT-6.1 Sol")
        #expect(choice.effort == .high)
        #expect(choice.speed == nil)

        choice.effort = .ultra
        choice.pick(fable)
        #expect(choice.effort == nil)
    }

    @Test func switchingRuntimeResetsTheModel() {
        var choice = RuntimeChoice(agent: .claudeCode, model: "Fable 5.2", effort: .high, speed: .fast)
        choice.switchRuntime(to: .codex)
        #expect(choice == RuntimeChoice(agent: .codex))
        choice.switchRuntime(to: .codex)
        #expect(choice == RuntimeChoice(agent: .codex))
    }

    @Test func pillShowsModelOrRuntimeThenSecondary() {
        #expect(RuntimeChoice(agent: .claudeCode).pillLabel == "Claude Code")
        #expect(RuntimeChoice(agent: .claudeCode).pillSecondary == nil)
        let tuned = RuntimeChoice(agent: .claudeCode, model: "Fable 5.2", effort: .xhigh, speed: .fast)
        #expect(tuned.pillLabel == "Fable 5.2")
        #expect(tuned.pillSecondary == "Extra High · Fast")
    }

    @Test func modelSearchMatchesLabelValueAndDescription() {
        let list = [fable, ModelOption(label: "Haiku 5.5", value: "haiku", agent: .claudeCode, description: "Fastest, most cost-efficient model.", efforts: Effort.lowToMax, supportsFastSpeed: false)]
        #expect(ModelOption.search(list, query: "  FAST ").map(\.value) == ["haiku"])
        #expect(ModelOption.search(list, query: "fable").map(\.value) == ["fable"])
        #expect(ModelOption.search(list, query: "").count == 2)
    }
}
