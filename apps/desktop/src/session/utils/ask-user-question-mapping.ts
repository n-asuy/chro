import type {
  AskUserAnswer,
  AskUserQuestionItem,
} from "../components/ask-user-questions";
import type { UserQuestion } from "../state/user-question-store";

/**
 * Mapping between the agent's AskUserQuestion tool shapes and the
 * AskUserQuestions UI component. Question ids are positional (`q-{index}`)
 * because the tool identifies answers by question text, not by id; option ids
 * are the option labels because the labels ARE the answer payload.
 */

export function questionId(index: number): string {
  return `q-${index}`;
}

export function toAskUserQuestionItems(
  questions: UserQuestion[],
): AskUserQuestionItem[] {
  return questions.map((q, i) => ({
    id: questionId(i),
    title: q.question,
    header: q.header,
    multiSelect: q.multiSelect,
    allowOther: true,
    options: q.options.map((option) => ({
      id: option.label,
      title: option.label,
      description: option.description,
    })),
  }));
}

/**
 * Folds the component's per-question answers back into the
 * `{ [questionText]: "label, label" }` record the executor's hook server
 * expects. Skipped and unanswered questions are omitted; a free-form "Other"
 * entry rides along with any selected labels.
 */
export function formatQuestionAnswers(
  questions: UserQuestion[],
  answers: Record<string, AskUserAnswer>,
): Record<string, string> {
  const formatted: Record<string, string> = {};
  questions.forEach((q, i) => {
    const answer = answers[questionId(i)];
    if (!answer || answer.skipped) return;
    const parts = [...answer.selectedIds];
    const other = answer.otherText?.trim();
    if (other) parts.push(other);
    if (parts.length > 0) {
      formatted[q.question] = parts.join(", ");
    }
  });
  return formatted;
}
