import ChroAPI
import Foundation

/// The agent's AskUserQuestion tool (state/user-question-store.ts).
public enum QuestionPrompt {
    public static let toolName = "AskUserQuestion"
    /// The denial reason when every question was skipped.
    public static let skippedMessage = "User skipped questions - proceed with defaults"
    public static let timedOutMessage = "Timed out"

    public struct Option: Equatable, Sendable, Hashable {
        public var label: String
        public var description: String

        public init(label: String, description: String) {
            self.label = label
            self.description = description
        }
    }

    public struct Question: Equatable, Sendable, Hashable {
        public var question: String
        public var header: String
        public var options: [Option]
        public var multiSelect: Bool

        public init(question: String, header: String, options: [Option], multiSelect: Bool) {
            self.question = question
            self.header = header
            self.options = options
            self.multiSelect = multiSelect
        }

        /// The header, else the question, as status lines name it.
        var name: String { header.isEmpty ? question : header }
    }

    /// The tool input's `questions`; malformed items are dropped.
    public static func questions(from input: JSONValue?) -> [Question] {
        (input?["questions"]?.arrayValue ?? []).compactMap { item in
            guard let question = item["question"]?.stringValue else { return nil }
            let options = (item["options"]?.arrayValue ?? []).compactMap { option -> Option? in
                guard let label = option["label"]?.stringValue else { return nil }
                return Option(label: label, description: option["description"]?.stringValue ?? "")
            }
            return Question(question: question, header: item["header"]?.stringValue ?? "", options: options,
                            multiSelect: item["multiSelect"]?.boolValue ?? false)
        }
    }
}

/// A question and the answer given to it, in question order.
public struct QuestionAnswerPair: Equatable, Sendable, Hashable {
    public var question: String
    public var answer: String

    public init(question: String, answer: String) {
        self.question = question
        self.answer = answer
    }
}

/// How the stepped card ended.
public enum QuestionOutcome: Equatable, Sendable {
    case answered([QuestionAnswerPair])
    /// Every question was skipped: the tool call is denied with `QuestionPrompt.skippedMessage`.
    case skipped

    /// `{question text: "label, label, other"}` for the approval response.
    public var answers: [String: String] {
        guard case .answered(let pairs) = self else { return [:] }
        return Dictionary(pairs.map { ($0.question, $0.answer) }, uniquingKeysWith: { first, _ in first })
    }
}

/// The AskUserQuestions card: one question at a time, single-select answers
/// on tap, multi-select on Continue/Finish, an "Other" field, Back and Skip.
public struct QuestionFlow: Equatable, Sendable {
    private struct Answer: Equatable, Sendable {
        var labels: [String]
        var skipped: Bool
    }

    public let questions: [QuestionPrompt.Question]
    public private(set) var index = 0
    private var answers: [Int: Answer] = [:]
    private var others: [Int: String] = [:]
    /// MCP approvals are a single non-skippable choice without "Other".
    public let skippable: Bool
    public let allowsOther: Bool

    public init(questions: [QuestionPrompt.Question], skippable: Bool = true, allowsOther: Bool = true) {
        self.questions = questions
        self.skippable = skippable
        self.allowsOther = allowsOther
    }

    public var current: QuestionPrompt.Question { questions[index] }
    public var total: Int { questions.count }

    /// `{header} • {n} of {total}`, or `Question {n} of {total}` without a header.
    public var headerParts: [String] {
        guard !current.header.isEmpty else { return ["Question \(index + 1) of \(total)"] }
        return total > 1 ? [current.header, "\(index + 1) of \(total)"] : [current.header]
    }

    /// The free text typed into "Other" for the current question.
    public var otherText: String {
        get { others[index] ?? "" }
        set { others[index] = newValue }
    }

    private var currentAnswer: Answer? { answers[index] }

    public var selectedLabels: [String] {
        guard let answer = currentAnswer, !answer.skipped else { return [] }
        return answer.labels
    }

    public func isSelected(_ option: Int) -> Bool { selectedLabels.contains(current.options[option].label) }

    /// A single-select answer that is none of the options was typed into Other.
    private var recordedOther: String? {
        guard !current.multiSelect, selectedLabels.count == 1, let label = selectedLabels.first,
              !current.options.contains(where: { $0.label == label }) else { return nil }
        return label
    }

    /// What the Other field shows: the typed text, or a recorded free answer.
    public var otherFieldText: String { otherText.isEmpty ? (recordedOther ?? "") : otherText }

    public var isOtherSelected: Bool { !otherFieldText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Single-select only: the arrow that submits the Other text.
    public var showsSubmitArrow: Bool {
        !current.multiSelect && !otherFieldText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var canContinue: Bool {
        !selectedLabels.isEmpty || !otherText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var showsBack: Bool { total > 1 && index > 0 }
    public var showsSkip: Bool { skippable }
    public var showsContinue: Bool { current.multiSelect }
    public var showsFooter: Bool { showsBack || showsSkip || showsContinue }
    public var continueTitle: String { index == total - 1 ? "Finish" : "Continue" }

    /// Single-select records and advances; multi-select toggles.
    @discardableResult
    public mutating func pick(_ option: Int) -> QuestionOutcome? {
        let label = current.options[option].label
        if current.multiSelect {
            var labels = selectedLabels
            if let at = labels.firstIndex(of: label) { labels.remove(at: at) } else { labels.append(label) }
            answers[index] = Answer(labels: labels, skipped: false)
            return nil
        }
        return record(Answer(labels: [label], skipped: false))
    }

    @discardableResult
    public mutating func submitOther() -> QuestionOutcome? {
        let text = otherFieldText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return record(Answer(labels: [text], skipped: false))
    }

    @discardableResult
    public mutating func continueMulti() -> QuestionOutcome? {
        var labels = selectedLabels
        let other = otherText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !other.isEmpty { labels.append(other) }
        guard !labels.isEmpty else { return nil }
        return record(Answer(labels: labels, skipped: false))
    }

    @discardableResult
    public mutating func skip() -> QuestionOutcome? { record(Answer(labels: [], skipped: true)) }

    public mutating func back() { index = max(0, index - 1) }

    private mutating func record(_ answer: Answer) -> QuestionOutcome? {
        answers[index] = answer
        if index < total - 1 {
            index += 1
            return nil
        }
        let pairs = questions.enumerated().compactMap { offset, question -> QuestionAnswerPair? in
            guard let answer = answers[offset], !answer.skipped, !answer.labels.isEmpty else { return nil }
            return QuestionAnswerPair(question: question.question, answer: answer.labels.joined(separator: ", "))
        }
        return pairs.isEmpty ? .skipped : .answered(pairs)
    }
}

/// The AskUserQuestion row inside the conversation (agent-ask-user-question-tool.tsx): read-only.
public enum QuestionTranscript: Equatable, Sendable {
    /// "Asking question..." while the questions stream in.
    case asking
    /// `{label} • {status}`
    case status(label: String, status: String)
    case answered([QuestionAnswerPair])
    /// "Question answered"
    case answeredWithoutEntries

    public var cardTitle: String {
        if case .answered(let pairs) = self, pairs.count > 1 { return "Answers" }
        return "Answer"
    }

    /// - Parameters:
    ///   - isPending: the tool call waits for the user's answer.
    ///   - isDialogShown: the answer card for this call is on screen.
    ///   - result: the tool result: `{answers}` or an error string.
    public static func derive(questions: [QuestionPrompt.Question], isPending: Bool, isDialogShown: Bool, result: JSONValue?, isError: Bool) -> QuestionTranscript {
        if isPending && (questions.isEmpty || !isDialogShown) { return .asking }
        let label = questions.first?.name ?? "Question"
        let errorText = result?.stringValue
        if !isPending, errorText == QuestionPrompt.skippedMessage || errorText == QuestionPrompt.timedOutMessage {
            return .status(label: label.isEmpty ? "Question" : label, status: errorText == QuestionPrompt.timedOutMessage ? "Timed out" : "Skipped")
        }
        if !isPending && isError {
            let message = (errorText ?? "").replacingOccurrences(of: "<tool_use_error>", with: "")
                .replacingOccurrences(of: "</tool_use_error>", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            return .status(label: "Question", status: message.isEmpty ? "Error" : message)
        }
        if !isPending, let answers = result?["answers"]?.objectValue {
            if answers.isEmpty { return .answeredWithoutEntries }
            let ordered = questions.compactMap { question in answers[question.question]?.stringValue.map { QuestionAnswerPair(question: question.question, answer: $0) } }
            let extra = answers.keys.filter { key in !questions.contains { $0.question == key } }.sorted()
                .compactMap { key in answers[key]?.stringValue.map { QuestionAnswerPair(question: key, answer: $0) } }
            return .answered(ordered + extra)
        }
        if isPending { return .status(label: label.isEmpty ? "Question" : label, status: "Waiting for response...") }
        return .status(label: label.isEmpty ? "Question" : label, status: "Interrupted")
    }
}
