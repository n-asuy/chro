import { HelpCircle } from "lucide-react";
import { memo, type ReactNode } from "react";
import {
  QUESTIONS_SKIPPED_MESSAGE,
  QUESTIONS_TIMED_OUT_MESSAGE,
  useUserQuestionStore,
} from "../state/user-question-store";
import { TextShimmer } from "./text-shimmer";

interface UserQuestionOption {
  label: string;
  description: string;
}

interface UserQuestion {
  question: string;
  header: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
}

interface AgentAskUserQuestionToolProps {
  input: {
    questions?: UserQuestion[];
  };
  result?:
    | {
        questions?: unknown;
        answers?: Record<string, string>;
      }
    | string;
  errorText?: string;
  state: "call" | "result";
  isError?: boolean;
  isStreaming?: boolean;
  toolCallId?: string;
}

// A single-line status row (e.g. "Question • Interrupted"). No vertical
// padding: the row sits in ThinkingStep's icon-column layout, whose icon box
// is centered on the text's line box. Adding py here would push the text below
// the icon's center and leave the icon riding high.
function QuestionStatusLine({
  label,
  status,
  statusTitle,
  truncateStatus = false,
}: {
  label: ReactNode;
  status?: ReactNode;
  statusTitle?: string;
  truncateStatus?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
      <span>{label}</span>
      {status != null && (
        <>
          <span className="text-muted-foreground/50">&bull;</span>
          <span
            className={truncateStatus ? "min-w-0 truncate" : undefined}
            title={statusTitle}
          >
            {status}
          </span>
        </>
      )}
    </div>
  );
}

function arePropsEqual(
  prev: AgentAskUserQuestionToolProps,
  next: AgentAskUserQuestionToolProps,
): boolean {
  if (prev.state !== next.state) return false;
  if (prev.isError !== next.isError) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.toolCallId !== next.toolCallId) return false;
  if (prev.errorText !== next.errorText) return false;

  const prevQuestions = prev.input?.questions;
  const nextQuestions = next.input?.questions;
  if (prevQuestions?.length !== nextQuestions?.length) return false;

  const prevResult = prev.result;
  const nextResult = next.result;
  if (typeof prevResult !== typeof nextResult) return false;
  if (typeof prevResult === "string" && prevResult !== nextResult) return false;
  if (typeof prevResult === "object" && typeof nextResult === "object") {
    const prevAnswers = prevResult?.answers;
    const nextAnswers = nextResult?.answers;
    if (JSON.stringify(prevAnswers) !== JSON.stringify(nextAnswers)) {
      return false;
    }
  }

  return true;
}

export const AgentAskUserQuestionTool = memo(function AgentAskUserQuestionTool({
  input,
  result,
  errorText,
  state,
  isError,
  isStreaming,
  toolCallId,
}: AgentAskUserQuestionToolProps) {
  const questions = input?.questions ?? [];
  const questionCount = questions.length;

  // Get real-time results from store (for immediate updates before DB sync)
  const resultsMap = useUserQuestionStore((s) => s.results);
  const realtimeResult = toolCallId ? resultsMap.get(toolCallId) : undefined;

  // Check if the question dialog is currently shown for this tool
  const pendingQuestionsMap = useUserQuestionStore((s) => s.pendingQuestions);
  const isDialogShown = toolCallId
    ? Array.from(pendingQuestionsMap.values()).some(
        (q) => q.toolUseId === toolCallId,
      )
    : false;

  // Use realtime result if available, otherwise fall back to prop
  const effectiveResult = realtimeResult ?? result;

  // For errors, SDK stores errorText separately - use it to detect skip/timeout
  const effectiveErrorText =
    errorText ||
    (typeof effectiveResult === "string" ? effectiveResult : undefined);

  // Extract answers for display
  const answers =
    effectiveResult &&
    typeof effectiveResult === "object" &&
    "answers" in effectiveResult
      ? (effectiveResult as { answers?: Record<string, string> }).answers
      : null;

  // Determine status
  const isSkipped = effectiveErrorText === QUESTIONS_SKIPPED_MESSAGE;
  const isTimedOut = effectiveErrorText === QUESTIONS_TIMED_OUT_MESSAGE;
  const isCompleted =
    state === "result" && answers && !isSkipped && !isTimedOut && !isError;

  // Show loading state if:
  // 1. No questions yet (still streaming input)
  // 2. Streaming but dialog not yet shown (waiting for ask-user-question chunk)
  if (
    state === "call" &&
    (questionCount === 0 || (isStreaming && !isDialogShown))
  ) {
    return (
      <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
        <TextShimmer className="text-xs" duration={1.5}>
          Asking question...
        </TextShimmer>
      </div>
    );
  }

  // Show skipped/timed out state
  if (state === "result" && (isSkipped || isTimedOut)) {
    const firstQuestion = questions[0]?.header || questions[0]?.question;
    return (
      <QuestionStatusLine
        label={firstQuestion || "Question"}
        status={isTimedOut ? "Timed out" : "Skipped"}
      />
    );
  }

  // Show error state — keep it quiet (muted, no alarm color) and strip the
  // transport-level <tool_use_error> wrapper from the message.
  if (state === "result" && isError) {
    const errorMessage = effectiveErrorText
      ?.replace(/<\/?tool_use_error>/g, "")
      .trim();
    return (
      <QuestionStatusLine
        label="Question"
        status={errorMessage || "Error"}
        statusTitle={errorMessage}
        truncateStatus
      />
    );
  }

  // Show completed state with card layout
  if (isCompleted && answers) {
    const entries = Object.entries(answers);
    if (entries.length === 0) {
      return <QuestionStatusLine label="Question answered" />;
    }

    return (
      <div className="mx-2 overflow-hidden rounded-lg border border-border bg-muted/30">
        {/* Header */}
        <div className="flex h-7 items-center gap-1.5 border-b border-border pl-2.5 pr-2">
          <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {entries.length === 1 ? "Answer" : "Answers"}
          </span>
        </div>
        {/* Content */}
        <div className="flex flex-col gap-2 p-2.5 text-xs">
          {entries.map(([question, answer]) => (
            <div key={question} className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">{question}</span>
              <span className="text-muted-foreground">{answer}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Show pending state
  const firstQuestion = questions[0]?.header || questions[0]?.question;

  // If streaming THIS message, show "Waiting for response..."
  if (isStreaming) {
    return (
      <QuestionStatusLine
        label={firstQuestion || "Question"}
        status="Waiting for response..."
      />
    );
  }

  // If we have a realtime result but it hasn't synced to the message yet,
  // show "Submitting..."
  if (
    state === "result" &&
    realtimeResult &&
    !answers &&
    !isError &&
    !isSkipped &&
    !isTimedOut
  ) {
    return (
      <QuestionStatusLine
        label={firstQuestion || "Question"}
        status="Submitting..."
      />
    );
  }

  // Not streaming and state is "call" - it was truly interrupted
  return (
    <QuestionStatusLine label={firstQuestion || "Question"} status="Interrupted" />
  );
}, arePropsEqual);
