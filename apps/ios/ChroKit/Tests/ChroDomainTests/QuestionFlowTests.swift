import ChroAPI
import ChroDomain
import XCTest

/// ask-user-questions.tsx, ask-user-question-mapping.ts and agent-ask-user-question-tool.tsx.
final class QuestionFlowTests: XCTestCase {
    private let policy = QuestionPrompt.Question(
        question: "Which restock policy should the reconciliation use?", header: "Policy",
        options: [.init(label: "Fixed reorder point", description: "Reorder when qty drops below a per-SKU threshold"),
                  .init(label: "Weekly batch", description: "Restock every Monday from last week sales"),
                  .init(label: "Manual only", description: "Never restock automatically")],
        multiSelect: false)
    private let alerts = QuestionPrompt.Question(
        question: "Which events should notify the store manager?", header: "Alerts",
        options: [.init(label: "Stock reaches 0", description: "One message per SKU"),
                  .init(label: "Restock placed", description: "Daily digest"),
                  .init(label: "Negative stock detected", description: "Immediately")],
        multiSelect: true)

    func testParsesTheToolInput() {
        let input: JSONValue = .object(["questions": .array([.object([
            "question": .string("Q?"), "header": .string("H"), "multiSelect": .bool(true),
            "options": .array([.object(["label": .string("A"), "description": .string("a")])]),
        ])])])
        XCTAssertEqual(QuestionPrompt.questions(from: input), [
            .init(question: "Q?", header: "H", options: [.init(label: "A", description: "a")], multiSelect: true),
        ])
        XCTAssertEqual(QuestionPrompt.questions(from: nil), [])
    }

    func testHeaderShowsPositionOnlyWithSeveralQuestions() {
        var flow = QuestionFlow(questions: [policy, alerts])
        XCTAssertEqual(flow.headerParts, ["Policy", "1 of 2"])
        flow.pick(0)
        XCTAssertEqual(flow.headerParts, ["Alerts", "2 of 2"])
        XCTAssertEqual(QuestionFlow(questions: [policy]).headerParts, ["Policy"])
        let untitled = QuestionPrompt.Question(question: "Q", header: "", options: [], multiSelect: false)
        XCTAssertEqual(QuestionFlow(questions: [untitled, untitled]).headerParts, ["Question 1 of 2"])
    }

    func testSingleSelectAdvancesOnPickAndMultiSelectFinishes() {
        var flow = QuestionFlow(questions: [policy, alerts])
        XCTAssertNil(flow.pick(1))
        XCTAssertEqual(flow.index, 1)
        XCTAssertTrue(flow.showsBack)
        XCTAssertFalse(flow.canContinue)
        XCTAssertEqual(flow.continueTitle, "Finish")
        flow.pick(0)
        flow.pick(2)
        flow.pick(0) // toggles off again
        XCTAssertEqual(flow.selectedLabels, ["Negative stock detected"])
        flow.otherText = "Supplier delay"
        XCTAssertTrue(flow.canContinue)
        XCTAssertEqual(flow.continueMulti(), .answered([
            .init(question: policy.question, answer: "Weekly batch"),
            .init(question: alerts.question, answer: "Negative stock detected, Supplier delay"),
        ]))
    }

    func testOtherTextAnswersASingleSelectQuestion() {
        var flow = QuestionFlow(questions: [policy])
        XCTAssertFalse(flow.showsSubmitArrow)
        XCTAssertNil(flow.submitOther(), "empty text does nothing")
        flow.otherText = "  Only when asked  "
        XCTAssertTrue(flow.showsSubmitArrow)
        XCTAssertTrue(flow.isOtherSelected)
        XCTAssertEqual(flow.submitOther(), .answered([.init(question: policy.question, answer: "Only when asked")]))
    }

    func testBackShowsThePreviousAnswerSelected() {
        var flow = QuestionFlow(questions: [policy, alerts])
        flow.otherText = "Custom"
        flow.submitOther()
        flow.back()
        XCTAssertEqual(flow.index, 0)
        XCTAssertTrue(flow.isOtherSelected)
        XCTAssertEqual(flow.otherFieldText, "Custom")
        XCTAssertFalse(flow.isSelected(0))
    }

    func testSkippingEveryQuestionDenies() {
        var flow = QuestionFlow(questions: [policy, alerts])
        XCTAssertTrue(flow.showsSkip)
        XCTAssertNil(flow.skip())
        XCTAssertEqual(flow.skip(), .skipped)
        var partly = QuestionFlow(questions: [policy, alerts])
        partly.skip()
        partly.pick(1)
        XCTAssertEqual(partly.continueMulti(), .answered([.init(question: alerts.question, answer: "Restock placed")]))
    }

    func testFooterRules() {
        let flow = QuestionFlow(questions: [policy])
        XCTAssertTrue(flow.showsFooter, "skippable")
        XCTAssertFalse(flow.showsBack)
        XCTAssertFalse(flow.showsContinue)
        XCTAssertTrue(QuestionFlow(questions: [alerts]).showsContinue)
        XCTAssertEqual(QuestionFlow(questions: [alerts, policy]).continueTitle, "Continue")
    }

    func testAnswersBodyForTheApproval() {
        XCTAssertEqual(QuestionOutcome.answered([.init(question: "Q", answer: "A")]).answers, ["Q": "A"])
        XCTAssertEqual(QuestionOutcome.skipped.answers, [:])
    }

    // MARK: transcript row

    private func transcript(pending: Bool = false, dialogShown: Bool = true, result: JSONValue? = nil, error: Bool = false,
                            questions: [QuestionPrompt.Question]? = nil) -> QuestionTranscript {
        QuestionTranscript.derive(questions: questions ?? [policy, alerts], isPending: pending, isDialogShown: dialogShown, result: result, isError: error)
    }

    func testTranscriptStates() {
        XCTAssertEqual(transcript(pending: true), .status(label: "Policy", status: "Waiting for response..."))
        XCTAssertEqual(transcript(pending: true, dialogShown: false), .asking)
        XCTAssertEqual(transcript(pending: true, questions: []), .asking)
        XCTAssertEqual(transcript(result: .string(QuestionPrompt.skippedMessage), error: true), .status(label: "Policy", status: "Skipped"))
        XCTAssertEqual(transcript(result: .string("Timed out"), error: true), .status(label: "Policy", status: "Timed out"))
        XCTAssertEqual(transcript(result: .string("<tool_use_error>Boom</tool_use_error>"), error: true), .status(label: "Question", status: "Boom"))
        XCTAssertEqual(transcript(result: .object(["answers": .object([:])])), .answeredWithoutEntries)
        XCTAssertEqual(transcript(result: .object(["answers": .object([alerts.question: .string("Stock reaches 0"), policy.question: .string("Weekly batch")])])),
                       .answered([.init(question: policy.question, answer: "Weekly batch"), .init(question: alerts.question, answer: "Stock reaches 0")]))
        XCTAssertEqual(transcript(), .status(label: "Policy", status: "Interrupted"))
        let unlabeled = QuestionPrompt.Question(question: "Proceed?", header: "", options: [], multiSelect: false)
        XCTAssertEqual(transcript(questions: [unlabeled]), .status(label: "Proceed?", status: "Interrupted"))
    }

    func testAnswerCardTitle() {
        XCTAssertEqual(QuestionTranscript.answered([.init(question: "Q", answer: "A")]).cardTitle, "Answer")
        XCTAssertEqual(QuestionTranscript.answered([.init(question: "Q", answer: "A"), .init(question: "R", answer: "B")]).cardTitle, "Answers")
    }
}
