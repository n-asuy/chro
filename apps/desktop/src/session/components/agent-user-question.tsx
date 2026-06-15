import { memo, useCallback, useMemo, useState } from "react";
import type { PendingUserQuestions } from "../state/user-question-store";
import {
  formatQuestionAnswers,
  toAskUserQuestionItems,
} from "../utils/ask-user-question-mapping";
import { type AskUserAnswer, AskUserQuestions } from "./ask-user-questions";

interface AgentUserQuestionProps {
  pendingQuestions: PendingUserQuestions;
  onAnswer: (answers: Record<string, string>) => void;
  onSkip: () => void;
}

/**
 * Bridges the agent's AskUserQuestion tool to the AskUserQuestions UI:
 * maps the tool's question shape onto the component and folds the per-question
 * answers back into the record the executor's hook server expects. Skipping
 * every question denies the tool call (the agent proceeds with defaults).
 */
export const AgentUserQuestion = memo(function AgentUserQuestion({
  pendingQuestions,
  onAnswer,
  onSkip,
}: AgentUserQuestionProps) {
  const { questions, toolUseId } = pendingQuestions;
  // Track which tool call was submitted (rather than a boolean) so a new
  // question set re-enables the panel without an effect-driven reset.
  const [submittedToolUseId, setSubmittedToolUseId] = useState<string | null>(
    null,
  );
  const isSubmitting = submittedToolUseId === toolUseId;

  const items = useMemo(() => toAskUserQuestionItems(questions), [questions]);

  const handleComplete = useCallback(
    (answers: Record<string, AskUserAnswer>) => {
      if (isSubmitting) return;

      const formatted = formatQuestionAnswers(questions, answers);

      setSubmittedToolUseId(toolUseId);
      if (Object.keys(formatted).length === 0) {
        onSkip();
      } else {
        onAnswer(formatted);
      }
    },
    [isSubmitting, toolUseId, questions, onAnswer, onSkip],
  );

  if (questions.length === 0) {
    return null;
  }

  return (
    <AskUserQuestions
      key={toolUseId}
      questions={items}
      onComplete={handleComplete}
      disabled={isSubmitting}
      className="mb-2"
    />
  );
});
