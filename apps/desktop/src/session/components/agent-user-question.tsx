
import {
  memo,
  useState,
  useEffect,
  useCallback,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import { ChevronUp, ChevronDown, CornerDownLeft } from "lucide-react";
import { Button } from "@chro/ui/button";
import { cn } from "@chro/ui/utils";
import type { PendingUserQuestions } from "../state/user-question-store";

interface AgentUserQuestionProps {
  pendingQuestions: PendingUserQuestions;
  onAnswer: (answers: Record<string, string>) => void;
  onSkip: () => void;
  hasCustomText?: boolean;
}

export interface AgentUserQuestionHandle {
  getAnswers: () => Record<string, string>;
}

export const AgentUserQuestion = memo(
  forwardRef<AgentUserQuestionHandle, AgentUserQuestionProps>(
    function AgentUserQuestion(
      {
        pendingQuestions,
        onAnswer,
        onSkip,
        hasCustomText = false,
      }: AgentUserQuestionProps,
      ref,
    ) {
      const { questions, toolUseId } = pendingQuestions;
      const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
      const [answers, setAnswers] = useState<Record<string, string[]>>({});
      const [focusedOptionIndex, setFocusedOptionIndex] = useState(0);
      const [isVisible, setIsVisible] = useState(true);
      const [isSubmitting, setIsSubmitting] = useState(false);
      const prevIndexRef = useRef(currentQuestionIndex);
      const prevToolUseIdRef = useRef(toolUseId);

      // Expose getAnswers method to parent via ref
      useImperativeHandle(
        ref,
        () => ({
          getAnswers: () => {
            const formattedAnswers: Record<string, string> = {};
            for (const question of questions) {
              const selected = answers[question.question] || [];
              if (selected.length > 0) {
                formattedAnswers[question.question] = selected.join(", ");
              }
            }
            return formattedAnswers;
          },
        }),
        [answers, questions],
      );

      // Reset when toolUseId changes (new question set)
      useEffect(() => {
        if (prevToolUseIdRef.current !== toolUseId) {
          setIsSubmitting(false);
          setCurrentQuestionIndex(0);
          setAnswers({});
          setFocusedOptionIndex(0);
          prevToolUseIdRef.current = toolUseId;
        }
      }, [toolUseId]);

      // Animate on question change
      useEffect(() => {
        if (prevIndexRef.current !== currentQuestionIndex) {
          setIsVisible(false);
          const timer = setTimeout(() => {
            setIsVisible(true);
          }, 50);
          prevIndexRef.current = currentQuestionIndex;
          return () => clearTimeout(timer);
        }
      }, [currentQuestionIndex]);

      if (questions.length === 0) {
        return null;
      }

      const currentQuestion = questions[currentQuestionIndex];
      const currentOptions = currentQuestion?.options || [];

      const isOptionSelected = (questionText: string, optionLabel: string) => {
        return answers[questionText]?.includes(optionLabel) || false;
      };

      // Handle option click - auto-advance for single-select questions
      const handleOptionClick = useCallback(
        (questionText: string, optionLabel: string, questionIndex: number) => {
          const question = questions[questionIndex];
          const allowMultiple = question?.multiSelect || false;
          const isLastQuestion = questionIndex === questions.length - 1;

          setAnswers((prev) => {
            const currentAnswers = prev[questionText] || [];

            if (allowMultiple) {
              if (currentAnswers.includes(optionLabel)) {
                return {
                  ...prev,
                  [questionText]: currentAnswers.filter(
                    (l) => l !== optionLabel,
                  ),
                };
              }
              return {
                ...prev,
                [questionText]: [...currentAnswers, optionLabel],
              };
            }
            return {
              ...prev,
              [questionText]: [optionLabel],
            };
          });

          // For single-select questions, auto-advance to next question
          if (!allowMultiple && !isLastQuestion) {
            setTimeout(() => {
              setCurrentQuestionIndex(questionIndex + 1);
              setFocusedOptionIndex(0);
            }, 150);
          }
        },
        [questions],
      );

      const handlePrevious = () => {
        if (currentQuestionIndex > 0) {
          setCurrentQuestionIndex(currentQuestionIndex - 1);
          setFocusedOptionIndex(0);
        }
      };

      const handleNext = () => {
        if (currentQuestionIndex < questions.length - 1) {
          setCurrentQuestionIndex(currentQuestionIndex + 1);
          setFocusedOptionIndex(0);
        }
      };

      const handleContinue = useCallback(() => {
        if (isSubmitting) return;

        const currentAnswer = answers[currentQuestion?.question] || [];
        if (currentAnswer.length === 0) return;

        if (currentQuestionIndex < questions.length - 1) {
          setCurrentQuestionIndex(currentQuestionIndex + 1);
          setFocusedOptionIndex(0);
        } else {
          // On the last question, validate ALL questions are answered before submit
          const allAnswered = questions.every(
            (q) => (answers[q.question] || []).length > 0,
          );
          if (allAnswered) {
            setIsSubmitting(true);
            // Convert answers to SDK format: { questionText: label } or { questionText: "label1, label2" } for multiSelect
            const formattedAnswers: Record<string, string> = {};
            for (const question of questions) {
              const selected = answers[question.question] || [];
              formattedAnswers[question.question] = selected.join(", ");
            }
            onAnswer(formattedAnswers);
          }
        }
      }, [
        onAnswer,
        answers,
        currentQuestionIndex,
        questions,
        currentQuestion?.question,
        isSubmitting,
      ]);

      const handleSkipWithGuard = useCallback(() => {
        if (isSubmitting) return;
        setIsSubmitting(true);
        onSkip();
      }, [isSubmitting, onSkip]);

      const getOptionNumber = (index: number) => {
        return String(index + 1);
      };

      const currentQuestionHasAnswer =
        (answers[currentQuestion?.question] || []).length > 0;
      const allQuestionsAnswered = questions.every(
        (q) => (answers[q.question] || []).length > 0,
      );
      const isLastQuestion = currentQuestionIndex === questions.length - 1;

      // Keyboard navigation
      useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
          if (isSubmitting) return;

          const activeEl = document.activeElement;
          if (
            activeEl instanceof HTMLInputElement ||
            activeEl instanceof HTMLTextAreaElement ||
            activeEl?.getAttribute("contenteditable") === "true"
          ) {
            return;
          }

          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (focusedOptionIndex < currentOptions.length - 1) {
              setFocusedOptionIndex(focusedOptionIndex + 1);
            } else if (currentQuestionIndex < questions.length - 1) {
              setCurrentQuestionIndex(currentQuestionIndex + 1);
              setFocusedOptionIndex(0);
            }
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (focusedOptionIndex > 0) {
              setFocusedOptionIndex(focusedOptionIndex - 1);
            } else if (currentQuestionIndex > 0) {
              const prevQuestionOptions =
                questions[currentQuestionIndex - 1]?.options || [];
              setCurrentQuestionIndex(currentQuestionIndex - 1);
              setFocusedOptionIndex(prevQuestionOptions.length - 1);
            }
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (currentQuestionHasAnswer) {
              handleContinue();
            } else if (currentOptions[focusedOptionIndex]) {
              handleOptionClick(
                currentQuestion.question,
                currentOptions[focusedOptionIndex].label,
                currentQuestionIndex,
              );
            }
          } else if (e.key >= "1" && e.key <= "9") {
            const numberIndex = parseInt(e.key, 10) - 1;
            if (numberIndex >= 0 && numberIndex < currentOptions.length) {
              e.preventDefault();
              handleOptionClick(
                currentQuestion.question,
                currentOptions[numberIndex].label,
                currentQuestionIndex,
              );
              setFocusedOptionIndex(numberIndex);
            }
          }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
      }, [
        currentOptions,
        currentQuestion,
        currentQuestionIndex,
        focusedOptionIndex,
        handleOptionClick,
        currentQuestionHasAnswer,
        handleContinue,
        questions,
        isSubmitting,
      ]);

      return (
        <div className="overflow-hidden rounded-t-xl border border-b-0 border-border bg-muted/30">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] text-muted-foreground">
                {currentQuestion?.header || "Question"}
              </span>
              <span className="text-muted-foreground/50">&bull;</span>
              <span className="text-[12px] text-muted-foreground">
                {currentQuestion?.multiSelect ? "Multi-select" : "Single-select"}
              </span>
            </div>

            {/* Navigation */}
            {questions.length > 1 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handlePrevious}
                  disabled={currentQuestionIndex === 0}
                  className="rounded p-0.5 outline-none hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                </button>
                <span className="px-1 text-xs text-muted-foreground">
                  {currentQuestionIndex + 1} / {questions.length}
                </span>
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={currentQuestionIndex === questions.length - 1}
                  className="rounded p-0.5 outline-none hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
            )}
          </div>

          {/* Current Question */}
          <div
            className={cn(
              "px-1 pb-2 transition-opacity duration-150 ease-out",
              isVisible ? "opacity-100" : "opacity-0",
            )}
          >
            <div className="mb-3 px-2 pt-1 text-[14px] font-[450] text-foreground">
              <span className="text-muted-foreground">
                {currentQuestionIndex + 1}.
              </span>{" "}
              {currentQuestion?.question}
            </div>

            {/* Options */}
            <div className="space-y-1">
              {currentOptions.map((option, optIndex) => {
                const isSelected = isOptionSelected(
                  currentQuestion.question,
                  option.label,
                );
                const isFocused = focusedOptionIndex === optIndex;
                const number = getOptionNumber(optIndex);

                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => {
                      if (isSubmitting) return;
                      handleOptionClick(
                        currentQuestion.question,
                        option.label,
                        currentQuestionIndex,
                      );
                      setFocusedOptionIndex(optIndex);
                    }}
                    disabled={isSubmitting}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-md p-2 text-left text-[13px] text-foreground outline-none transition-colors",
                      isFocused ? "bg-muted/70" : "hover:bg-muted/50",
                      isSubmitting && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[10px] font-medium transition-colors",
                        isSelected
                          ? "bg-foreground text-background"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {number}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span
                        className={cn(
                          "text-[13px] font-medium transition-colors",
                          isSelected ? "text-foreground" : "text-foreground",
                        )}
                      >
                        {option.label}
                      </span>
                      {option.description && (
                        <span className="text-[12px] text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-2 py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSkipWithGuard}
              disabled={isSubmitting}
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              Skip All
            </Button>
            <Button
              size="sm"
              onClick={handleContinue}
              disabled={
                isSubmitting ||
                hasCustomText ||
                (isLastQuestion ? !allQuestionsAnswered : !currentQuestionHasAnswer)
              }
              className="h-6 rounded-md px-3 text-xs"
            >
              {isSubmitting ? (
                "Sending..."
              ) : (
                <>
                  {isLastQuestion ? "Submit" : "Continue"}
                  <CornerDownLeft className="ml-1 h-3 w-3 opacity-60" />
                </>
              )}
            </Button>
          </div>
        </div>
      );
    },
  ),
);
