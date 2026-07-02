import { Button } from "@chro/ui/button";
import { cn } from "@chro/ui/utils";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight } from "lucide-react";
import {
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Run,
  SelectionBackgrounds,
  useMergeSplitBlocks,
} from "../hooks/use-merge-split";
import { useProximityHover } from "../hooks/use-proximity-hover";

/**
 * Stepped question flow for agent-initiated user intake, ported from
 * fluidfunctionalism.com's ask-user-questions component: one question at a
 * time with numbered option rows, a morphing hover indicator, merged selected
 * backgrounds, a free-form "Other" row, and Back/Skip/Continue navigation.
 * Adapted to chro's stack — framer-motion only, lucide icons, shadcn tokens.
 */

const SPRING_FAST = { type: "spring", duration: 0.08, bounce: 0 } as const;
const SPRING_SLOW = { type: "spring", duration: 0.24, bounce: 0.1 } as const;

// Fixed shape scale (the upstream component reads these from a shape
// context; chro uses one rounded scale everywhere).
const SHAPE_BG = "rounded-md";
const SHAPE_BG_RADIUS = 6;
const SHAPE_ITEM = "rounded-md";
const SHAPE_FOCUS_RING = "rounded-lg";

export interface AskUserOption {
  id?: string;
  title: string;
  description?: string;
}

export interface AskUserQuestionItem {
  id?: string;
  title: string;
  /** Short context label shown in the card header (e.g. "Auth method"). */
  header?: string;
  options: AskUserOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
  otherPlaceholder?: string;
  skippable?: boolean;
  nextLabel?: string;
}

export interface AskUserAnswer {
  questionId: string;
  selectedIds: string[];
  otherText?: string;
  skipped?: boolean;
}

export interface AskUserQuestionsProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  questions: AskUserQuestionItem[];
  onComplete?: (answers: Record<string, AskUserAnswer>) => void;
  onAnswersChange?: (answers: Record<string, AskUserAnswer>) => void;
  skipLabel?: string;
  /** Disables every input while an answer submission is in flight. */
  disabled?: boolean;
}

function questionKey(q: AskUserQuestionItem, i: number) {
  return q.id ?? `q-${i}`;
}

function optionKey(o: AskUserOption, i: number) {
  return o.id ?? `o-${i}`;
}

export const AskUserQuestions = forwardRef<
  HTMLDivElement,
  AskUserQuestionsProps
>(function AskUserQuestions(
  {
    questions,
    onComplete,
    onAnswersChange,
    skipLabel = "Skip",
    disabled = false,
    className,
    ...rest
  },
  ref,
) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, AskUserAnswer>>({});

  const answersRef = useRef(answers);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  const writeAnswers = useCallback(
    (
      updater: (
        prev: Record<string, AskUserAnswer>,
      ) => Record<string, AskUserAnswer>,
    ) => {
      const next = updater(answersRef.current);
      answersRef.current = next;
      setAnswers(next);
      onAnswersChange?.(next);
      return next;
    },
    [onAnswersChange],
  );

  // ⌘ on macOS, ⌃ (Control) elsewhere for the Continue shortcut hint.
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    const nav = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    const platform = nav.userAgentData?.platform || nav.platform || "";
    setIsMac(/mac/i.test(platform));
  }, []);

  const reactId = useId();
  const total = questions.length;
  const safeIndex = Math.max(0, Math.min(index, Math.max(0, total - 1)));
  const question = questions[safeIndex];
  const qId = question ? questionKey(question, safeIndex) : "";
  const currentAnswer = answers[qId];

  const isMulti = !!question?.multiSelect;
  const isSkippable = question?.skippable !== false;
  const allowOther = !!question?.allowOther;
  const selectedIds = useMemo(
    () => currentAnswer?.selectedIds ?? [],
    [currentAnswer],
  );
  const otherText = currentAnswer?.otherText ?? "";

  const options = question?.options ?? [];
  const otherIndex = allowOther ? options.length : -1;
  const rowCount = options.length + (allowOther ? 1 : 0);

  // ── Refs & proximity hover ───────────────────────────────────
  const rowsContainerRef = useRef<HTMLDivElement>(null);
  // The Other field is a multi-line textarea — it auto-resizes to fit
  // wrapped content and lets users press Enter for a newline.
  const otherInputRef = useRef<HTMLTextAreaElement>(null);
  // Stable IDs for contiguous-selection runs (see selectedGroups below).
  const groupIdCounterRef = useRef(0);
  const prevGroupMapRef = useRef(new Map<number, number>());
  const {
    activeIndex,
    setActiveIndex,
    itemRects,
    sessionRef,
    handlers,
    registerItem,
    measureItems,
  } = useProximityHover(rowsContainerRef);

  // Remeasure on row count change and question change.
  useEffect(() => {
    measureItems();
  }, [measureItems, qId, rowCount]);

  // ── Other-row textarea auto-resize ──────────────────────────
  // Browsers don't auto-fit textarea height to content, so set it manually:
  // reset to 0 (so the field can shrink when lines are deleted), then expand
  // to scrollHeight. Remeasure the proximity rows after — the hover, selected
  // and focus indicators absolutely-position against itemRects, so they need
  // fresh rects when the row's height changes. Track whether the textarea is
  // showing more than one line; only then is the Other row top-aligned, so a
  // single line stays at the row's optical centre like its neighbours.
  const [isOtherMultiline, setIsOtherMultiline] = useState(false);
  useEffect(() => {
    setIsOtherMultiline(false);
  }, [qId]);
  useEffect(() => {
    const el = otherInputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
    // Threshold against the measured line-height so the flag stays correct at
    // high zoom; 1.5× sits below a true second line but above rounding noise.
    const lineHeight =
      Number.parseFloat(window.getComputedStyle(el).lineHeight) || 18;
    setIsOtherMultiline(el.scrollHeight > lineHeight * 1.5);
    measureItems();
  }, [otherText, measureItems, qId]);

  // ── Animated height ──────────────────────────────────────────
  // Track the natural height of the Q/A content and animate the wrapper's
  // REAL height to it, so the card border and the footer reflow frame-by-frame
  // with the spring across question swaps and text wrapping.
  const contentMeasureRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | "auto">("auto");
  useEffect(() => {
    const el = contentMeasureRef.current;
    if (!el) return;
    const update = () => setContentHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  // Reset transient state when question changes
  useEffect(() => {
    setActiveIndex(null);
    setFocusedIndex(null);
  }, [safeIndex, setActiveIndex]);

  // ── Keyboard focus restoration across question changes ───────
  // The question content remounts on qId, which destroys the focused row and
  // drops focus to <body>. If we navigated from within the rows (keyboard
  // driving), refocus the new question's first row so arrows keep routing
  // here.
  const restoreFocusRef = useRef(false);
  const markFocusRestore = useCallback(() => {
    if (rowsContainerRef.current?.contains(document.activeElement)) {
      restoreFocusRef.current = true;
    }
  }, []);
  useEffect(() => {
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const firstRow = rowsContainerRef.current?.querySelector(
      '[data-proximity-index="0"]',
    ) as HTMLElement | null;
    firstRow?.focus();
  }, [safeIndex]);

  // ── Answer actions ───────────────────────────────────────────
  const goNext = useCallback(
    (snapshot: Record<string, AskUserAnswer>) => {
      if (safeIndex >= total - 1) {
        onComplete?.(snapshot);
      } else {
        markFocusRestore();
        setIndex(safeIndex + 1);
      }
    },
    [safeIndex, total, onComplete, markFocusRestore],
  );

  const handleSingleSelect = useCallback(
    (optId: string) => {
      if (!question || disabled) return;
      const text = answersRef.current[qId]?.otherText;
      const snapshot = writeAnswers((prev) => ({
        ...prev,
        [qId]: {
          questionId: qId,
          selectedIds: [optId],
          otherText: text || undefined,
          skipped: false,
        },
      }));
      goNext(snapshot);
    },
    [question, disabled, qId, writeAnswers, goNext],
  );

  const handleMultiToggle = useCallback(
    (optId: string) => {
      if (!question || disabled) return;
      writeAnswers((prev) => {
        const existing = prev[qId];
        const set = new Set(existing?.selectedIds ?? []);
        if (set.has(optId)) set.delete(optId);
        else set.add(optId);
        return {
          ...prev,
          [qId]: {
            questionId: qId,
            selectedIds: Array.from(set),
            otherText: existing?.otherText,
            skipped: false,
          },
        };
      });
    },
    [question, disabled, qId, writeAnswers],
  );

  const handleOtherChange = useCallback(
    (text: string) => {
      if (!question || disabled) return;
      writeAnswers((prev) => ({
        ...prev,
        [qId]: {
          questionId: qId,
          selectedIds: prev[qId]?.selectedIds ?? [],
          otherText: text,
          skipped: false,
        },
      }));
    },
    [question, disabled, qId, writeAnswers],
  );

  const handleOtherSubmit = useCallback(() => {
    if (!question || disabled) return;
    const text = (answersRef.current[qId]?.otherText ?? "").trim();
    if (!text) return;
    const snapshot = writeAnswers((prev) => ({
      ...prev,
      [qId]: {
        questionId: qId,
        selectedIds: prev[qId]?.selectedIds ?? [],
        otherText: text,
        skipped: false,
      },
    }));
    goNext(snapshot);
  }, [question, disabled, qId, writeAnswers, goNext]);

  const handleSkip = useCallback(() => {
    if (!question || disabled) return;
    const snapshot = writeAnswers((prev) => ({
      ...prev,
      [qId]: {
        questionId: qId,
        selectedIds: prev[qId]?.selectedIds ?? [],
        otherText: prev[qId]?.otherText,
        skipped: true,
      },
    }));
    goNext(snapshot);
  }, [question, disabled, qId, writeAnswers, goNext]);

  const handleMultiNext = useCallback(() => {
    if (disabled) return;
    goNext(answersRef.current);
  }, [disabled, goNext]);

  const handleBack = useCallback(() => {
    if (disabled) return;
    if (safeIndex > 0) {
      markFocusRestore();
      setIndex(safeIndex - 1);
    }
  }, [disabled, safeIndex, markFocusRestore]);

  // ── Keyboard shortcuts: 1-9 ──────────────────────────────────
  useEffect(() => {
    if (!question || disabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable)
        return;
      const code = e.key;
      if (code < "1" || code > "9") return;
      const idx = Number.parseInt(code, 10) - 1;
      if (idx >= 0 && idx < options.length) {
        e.preventDefault();
        const oid = optionKey(options[idx]!, idx);
        if (isMulti) handleMultiToggle(oid);
        else handleSingleSelect(oid);
      } else if (idx === options.length && allowOther) {
        e.preventDefault();
        otherInputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    question,
    disabled,
    options,
    isMulti,
    allowOther,
    handleSingleSelect,
    handleMultiToggle,
  ]);

  // ── Keyboard navigation ──────────────────────────────────────
  // Up/Down move the highlight between rows using the SAME indicator as mouse
  // hover (activeIndex), so keyboard and pointer focus look identical.
  // Left = Back, Right = Skip.
  const focusRow = (idx: number) => {
    const el = rowsContainerRef.current?.querySelector(
      `[data-proximity-index="${idx}"]`,
    ) as HTMLElement | null;
    el?.focus();
  };

  const moveActive = useCallback(
    (next: number) => {
      setActiveIndex(next);
      // The Other row is a text field — focus the input directly so typing
      // works; everything else focuses the row for Enter/Space selection.
      if (allowOther && next === otherIndex) otherInputRef.current?.focus();
      else focusRow(next);
    },
    [allowOther, otherIndex, setActiveIndex],
  );

  const handleNavKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const isTextInput =
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable;

    // Inside the Other text field, ←/→ and Home/End move the caret natively.
    // ↑/↓ only steal the keystroke when the caret is already at the first /
    // last position — otherwise the user can't edit a multi-line draft
    // without focus jumping out of the field.
    if (isTextInput && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (
      isTextInput &&
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      target.tagName === "TEXTAREA"
    ) {
      const ta = target as HTMLTextAreaElement;
      if (e.key === "ArrowUp" && ta.selectionStart > 0) return;
      if (e.key === "ArrowDown" && ta.selectionEnd < ta.value.length) return;
    }

    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowLeft") {
        if (safeIndex > 0) handleBack();
      } else if (isSkippable) {
        handleSkip();
      }
      return;
    }

    if (rowCount === 0) return;
    if (
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "Home" ||
      e.key === "End"
    ) {
      e.preventDefault();
      e.stopPropagation();
      let next: number;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = rowCount - 1;
      else {
        // When focus is in the Other field, treat it as the Other row.
        const base = isTextInput ? otherIndex : activeIndex ?? -1;
        next = e.key === "ArrowDown" ? base + 1 : base - 1;
        next = (next + rowCount) % rowCount;
      }
      moveActive(next);
    }
  };

  // Cmd+Enter (macOS) / Ctrl+Enter elsewhere commits a multi-select question,
  // mirroring the Continue button. Handled at the root so it works wherever
  // focus sits inside the card.
  const handleRootKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod || !isMulti) return;
    e.preventDefault(); // keep a focused button/row from also activating
    const hasAnswer = selectedIds.length > 0 || otherText.trim().length > 0;
    if (hasAnswer) handleMultiNext();
  };

  // ── Layout calculations for hover/focus indicators ───────────
  const activeRect = activeIndex !== null ? itemRects[activeIndex] : null;
  // The morphing focus ring is suppressed for the Other field: that row has
  // its own input-field treatment, so the ring reads as noise while typing.
  const focusRect =
    focusedIndex !== null && !(allowOther && focusedIndex === otherIndex)
      ? itemRects[focusedIndex]
      : null;

  // ── Selected-row grouping (merges contiguous selections) ─────
  // Contiguous selected indices collapse into a single rounded background
  // block; stable IDs let framer-motion morph block size/position when
  // neighbours toggle. The Other row joins when it has text so it merges into
  // the same block as adjacent selected options.
  const selectedIndices = new Set<number>();
  options.forEach((opt, i) => {
    if (selectedIds.includes(optionKey(opt, i))) selectedIndices.add(i);
  });
  if (allowOther && otherText.length > 0) selectedIndices.add(otherIndex);

  const runs: { start: number; end: number }[] = [];
  for (const idx of [...selectedIndices].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && idx === last.end + 1) last.end = idx;
    else runs.push({ start: idx, end: idx });
  }
  // Stable run IDs so a growing/shrinking run animates instead of
  // exit+re-enter when neighbours flip.
  const usedIds = new Set<number>();
  const nextGroupMap = new Map<number, number>();
  const selectedGroups: Run[] = runs.map((run) => {
    let stableId: number | null = null;
    for (let i = run.start; i <= run.end; i++) {
      const prev = prevGroupMapRef.current.get(i);
      if (prev !== undefined && !usedIds.has(prev)) {
        stableId = prev;
        break;
      }
    }
    const id = stableId ?? ++groupIdCounterRef.current;
    usedIds.add(id);
    for (let i = run.start; i <= run.end; i++) nextGroupMap.set(i, id);
    return { ...run, id };
  });
  prevGroupMapRef.current = nextGroupMap;

  // True when the user is hovering a row that ISN'T part of any selected run —
  // the selected backgrounds dim slightly to spotlight the hover target.
  const isHoveringNonSelected =
    activeIndex !== null && !selectedIndices.has(activeIndex);

  const blocks = useMergeSplitBlocks(
    selectedGroups,
    itemRects,
    SHAPE_BG_RADIUS,
  );

  if (!question) {
    return null;
  }

  const showBack = total > 1 && safeIndex > 0;
  const showSkip = isSkippable;
  const showFooter = showBack || showSkip || isMulti;

  const headerLabel = question.header?.trim();

  return (
    <div
      ref={ref}
      className={cn(
        // overflow-hidden crops the footer buttons to the card's rounded
        // bounds, so a button animating out is clipped at the edge instead of
        // visibly flying outside the card.
        "relative w-full overflow-hidden rounded-xl border border-border bg-card",
        disabled && "pointer-events-none opacity-70",
        className,
      )}
      {...rest}
      onKeyDown={(e) => {
        rest.onKeyDown?.(e);
        handleRootKey(e);
      }}
    >
      {/* Header — static top, fixed across questions; only the number
          changes. Lives outside the morphing region so it never shifts. */}
      <div className="flex items-center gap-1.5 px-4 pb-2 pt-4 text-[12px] text-muted-foreground">
        {headerLabel ? (
          <>
            <span>{headerLabel}</span>
            {total > 1 && (
              <>
                <span className="text-muted-foreground/50">&bull;</span>
                <span>
                  {safeIndex + 1} of {total}
                </span>
              </>
            )}
          </>
        ) : (
          <span>
            Question {safeIndex + 1} of {total}
          </span>
        )}
      </div>

      {/* Morphing Q/A region — its REAL height animates to the measured
          natural height of the content below, so the card border and the
          footer reflow in lockstep with the spring. */}
      <motion.div
        animate={{ height: contentHeight }}
        initial={false}
        transition={SPRING_SLOW}
        className="overflow-hidden"
      >
        <div
          ref={contentMeasureRef}
          className={cn("px-4", showFooter ? "pb-1" : "pb-3")}
        >
          <div key={qId} className="flex flex-col gap-2">
            {/* Question title */}
            <h3
              id={`${reactId}-${qId}-title`}
              className="text-[15px] font-semibold leading-snug text-foreground"
            >
              {question.title}
            </h3>

            {/* Options + Other (proximity-tracked container) */}
            <div
              ref={rowsContainerRef}
              role={isMulti ? "group" : "radiogroup"}
              aria-labelledby={`${reactId}-${qId}-title`}
              onMouseEnter={handlers.onMouseEnter}
              onMouseMove={handlers.onMouseMove}
              onMouseLeave={handlers.onMouseLeave}
              onKeyDown={handleNavKey}
              className="relative -mx-3 flex flex-col gap-0.5"
            >
              {/* Other-row input hint — shown only when the Other input is
                  focused and still empty, to signal "type here". With text,
                  the row joins selectedIndices and inherits the merged bg. */}
              <AnimatePresence>
                {(() => {
                  if (!allowOther) return null;
                  const otherRect = itemRects[otherIndex];
                  const isEmptyFocused =
                    focusedIndex === otherIndex && otherText.length === 0;
                  if (!otherRect || !isEmptyFocused) return null;
                  return (
                    <motion.div
                      key="other-input"
                      aria-hidden
                      className={cn(
                        "pointer-events-none absolute bg-card ring-1 ring-inset ring-border",
                        SHAPE_BG,
                      )}
                      initial={{
                        opacity: 0,
                        top: otherRect.top,
                        left: otherRect.left,
                        width: otherRect.width,
                        height: otherRect.height,
                      }}
                      animate={{
                        opacity: 1,
                        top: otherRect.top,
                        left: otherRect.left,
                        width: otherRect.width,
                        height: otherRect.height,
                      }}
                      exit={{ opacity: 0, transition: { duration: 0.08 } }}
                      transition={{
                        ...SPRING_FAST,
                        opacity: { duration: 0.08 },
                      }}
                    />
                  );
                })()}
              </AnimatePresence>

              {/* Single morphing hover indicator (below selected bg so a
                  hovered+selected row still reads as clearly selected) */}
              <AnimatePresence>
                {activeRect && (
                  <motion.div
                    key={`hover-${sessionRef.current}`}
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute bg-muted",
                      SHAPE_BG,
                    )}
                    initial={{
                      opacity: 0,
                      top: activeRect.top,
                      left: activeRect.left,
                      width: activeRect.width,
                      height: activeRect.height,
                    }}
                    animate={{
                      opacity: 1,
                      top: activeRect.top,
                      left: activeRect.left,
                      width: activeRect.width,
                      height: activeRect.height,
                    }}
                    exit={{ opacity: 0, transition: { duration: 0.06 } }}
                    transition={{
                      ...SPRING_FAST,
                      opacity: { duration: 0.08 },
                    }}
                  />
                )}
              </AnimatePresence>

              {/* Selected-row backgrounds (merged for contiguous selections,
                  with the merge/split boundary animation). Renders ABOVE the
                  hover indicator so the selected state stays readable when
                  mousing over a row. */}
              <SelectionBackgrounds
                blocks={blocks}
                dimmed={isHoveringNonSelected}
              />

              {/* Single morphing focus ring */}
              <AnimatePresence>
                {focusRect && (
                  <motion.div
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute z-20 border border-[#6B97FF]",
                      SHAPE_FOCUS_RING,
                    )}
                    initial={{
                      opacity: 0,
                      top: focusRect.top - 2,
                      left: focusRect.left - 2,
                      width: focusRect.width + 4,
                      height: focusRect.height + 4,
                    }}
                    animate={{
                      opacity: 1,
                      top: focusRect.top - 2,
                      left: focusRect.left - 2,
                      width: focusRect.width + 4,
                      height: focusRect.height + 4,
                    }}
                    exit={{ opacity: 0, transition: { duration: 0.06 } }}
                    transition={{
                      ...SPRING_FAST,
                      opacity: { duration: 0.08 },
                    }}
                  />
                )}
              </AnimatePresence>

              {options.map((opt, i) => {
                const oid = optionKey(opt, i);
                const isSelected = selectedIds.includes(oid);
                const isHover = activeIndex === i;
                const showArrow = !isMulti && isHover;
                return (
                  <Row
                    key={oid}
                    index={i}
                    registerItem={registerItem}
                    ariaRole={isMulti ? "checkbox" : "radio"}
                    isSelected={isSelected}
                    tabIndex={
                      isMulti
                        ? 0
                        : selectedIds[0] === oid ||
                            (!selectedIds.length && i === 0)
                          ? 0
                          : -1
                    }
                    onFocusVisible={() => setActiveIndex(i)}
                    onBlurAny={() =>
                      setActiveIndex((prev) => (prev === i ? null : prev))
                    }
                    onClick={() =>
                      isMulti ? handleMultiToggle(oid) : handleSingleSelect(oid)
                    }
                    onKeyDown={(e) => {
                      // Let ⌘/Ctrl+Enter fall through to the root handler
                      // (Continue) instead of toggling the focused row.
                      if (
                        (e.key === " " || e.key === "Enter") &&
                        !e.metaKey &&
                        !e.ctrlKey
                      ) {
                        e.preventDefault();
                        if (isMulti) handleMultiToggle(oid);
                        else handleSingleSelect(oid);
                      }
                    }}
                    aria-checked={isSelected}
                    chipContent={i + 1}
                    chipFilled={isSelected}
                    isMulti={isMulti}
                    showArrow={showArrow}
                  >
                    <span>
                      <span className="inline-grid">
                        <span
                          className="invisible col-start-1 row-start-1 font-semibold"
                          aria-hidden="true"
                        >
                          {opt.title}
                        </span>
                        <span
                          className={cn(
                            "col-start-1 row-start-1 text-foreground",
                            isSelected ? "font-semibold" : "font-medium",
                          )}
                        >
                          {opt.title}
                        </span>
                      </span>
                      {opt.description && (
                        <>
                          {" "}
                          <span className="text-muted-foreground">
                            {opt.description}
                          </span>
                        </>
                      )}
                    </span>
                  </Row>
                );
              })}

              {allowOther && (
                <Row
                  index={otherIndex}
                  registerItem={registerItem}
                  ariaRole={null}
                  isSelected={otherText.length > 0}
                  tabIndex={-1}
                  onFocusVisible={() => setFocusedIndex(otherIndex)}
                  onBlurAny={() =>
                    setFocusedIndex((prev) =>
                      prev === otherIndex ? null : prev,
                    )
                  }
                  onClick={() => otherInputRef.current?.focus()}
                  chipContent={otherIndex + 1}
                  chipFilled={otherText.length > 0}
                  isMulti={isMulti}
                  // Other body is a textarea that may grow past one line; only
                  // switch to top-aligned when it actually wraps, so a single
                  // line stays visually centred like the option rows.
                  topAlign={isOtherMultiline}
                  ariaLabel={
                    question.otherPlaceholder ?? "Describe in your own words"
                  }
                  showArrow={
                    !isMulti &&
                    (focusedIndex === otherIndex ||
                      activeIndex === otherIndex) &&
                    otherText.trim().length > 0
                  }
                  onArrowClick={
                    !isMulti && otherText.trim().length > 0
                      ? handleOtherSubmit
                      : undefined
                  }
                >
                  <span className="inline-grid w-full">
                    <textarea
                      ref={otherInputRef}
                      rows={1}
                      value={otherText}
                      disabled={disabled}
                      placeholder={
                        question.otherPlaceholder ??
                        "Describe in your own words…"
                      }
                      aria-label={
                        question.otherPlaceholder ??
                        "Describe in your own words"
                      }
                      onChange={(e) => handleOtherChange(e.target.value)}
                      onFocus={() => setFocusedIndex(otherIndex)}
                      onBlur={() =>
                        setFocusedIndex((prev) =>
                          prev === otherIndex ? null : prev,
                        )
                      }
                      onKeyDown={(e) => {
                        // Standard chat pattern: plain Enter submits,
                        // Shift+Enter inserts a newline. In multi-select,
                        // plain Enter stays a newline and the root handler
                        // catches ⌘/⌃+Enter for Continue.
                        if (e.key !== "Enter") return;
                        if (e.shiftKey) return; // Shift+Enter = newline
                        if (!isMulti) {
                          e.preventDefault();
                          handleOtherSubmit();
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="col-start-1 row-start-1 m-0 block w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-[13px] font-medium leading-snug text-foreground outline-none placeholder:text-muted-foreground"
                    />
                  </span>
                </Row>
              )}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Footer — outside the morphing region, so the animating height never
          clips it. */}
      {showFooter && (
        <div className="px-4 pb-2 pt-1">
          <div className="-mx-2 flex items-center justify-between gap-2">
            {/* popLayout pops an exiting button out of flow so its neighbours
                slide to their new spot while it fades. The group is `relative`
                so the popped button stays put instead of flying away. */}
            <div className="relative flex items-center gap-2">
              <AnimatePresence mode="popLayout" initial={false}>
                {showBack && (
                  <motion.div
                    key="back"
                    layout="position"
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    transition={{
                      ...SPRING_FAST,
                      opacity: { duration: 0.1 },
                    }}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleBack}
                      disabled={disabled}
                      className="h-7 gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <ArrowLeft className="h-3.5 w-3.5" />
                      Back
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className="relative flex items-center gap-2">
              <AnimatePresence mode="popLayout" initial={false}>
                {showSkip && (
                  <motion.div
                    key="skip"
                    layout="position"
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    transition={{
                      ...SPRING_FAST,
                      opacity: { duration: 0.1 },
                    }}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleSkip}
                      disabled={disabled}
                      className="h-7 gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {skipLabel}
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </motion.div>
                )}
                {isMulti && (
                  <motion.div
                    key="continue"
                    layout="position"
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    transition={{
                      ...SPRING_FAST,
                      opacity: { duration: 0.1 },
                    }}
                  >
                    <Button
                      size="sm"
                      onClick={handleMultiNext}
                      disabled={
                        disabled ||
                        (selectedIds.length === 0 &&
                          otherText.trim().length === 0)
                      }
                      className="h-7 gap-1.5 rounded-md px-3 text-xs"
                    >
                      {question.nextLabel ??
                        (safeIndex >= total - 1 ? "Finish" : "Continue")}
                      {/* Shortcut hint — sits inside the button so it dims
                          with the disabled state. ⌘↵ on macOS, ⌃↵ elsewhere. */}
                      <ShortcutChip>
                        {isMac ? "⌘" : "⌃"}
                        {"↵"}
                      </ShortcutChip>
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

// ── Shortcut chip ─────────────────────────────────────────────
// Small keycap showing the keyboard shortcut for an action, rendered on the
// dark primary button.
function ShortcutChip({ children }: { children: ReactNode }) {
  return (
    <kbd
      aria-hidden
      className="inline-flex h-[18px] min-w-[18px] items-center justify-center gap-0.5 rounded bg-primary-foreground/15 px-1 font-sans text-[11px] leading-none tracking-wide text-primary-foreground"
    >
      {children}
    </kbd>
  );
}

// ── Row sub-component ─────────────────────────────────────────

interface RowProps {
  index: number;
  registerItem: (index: number, element: HTMLElement | null) => void;
  ariaRole: "radio" | "checkbox" | null;
  isSelected: boolean;
  tabIndex: number;
  onFocusVisible: () => void;
  onBlurAny: () => void;
  onClick: () => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  chipContent: ReactNode;
  chipFilled: boolean;
  isMulti: boolean;
  ariaLabel?: string;
  "aria-checked"?: boolean;
  showArrow?: boolean;
  onArrowClick?: () => void;
  /** Anchor the chip to the first line of the body instead of vertically
   *  centering it on the row — used when the body can grow past one line
   *  (the Other row's textarea), so the chip keeps marking the first line. */
  topAlign?: boolean;
  children: ReactNode;
}

function Row({
  index,
  registerItem,
  ariaRole,
  isSelected,
  tabIndex,
  onFocusVisible,
  onBlurAny,
  onClick,
  onKeyDown,
  chipContent,
  chipFilled,
  isMulti,
  ariaLabel,
  showArrow,
  onArrowClick,
  topAlign = false,
  children,
  ...aria
}: RowProps) {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerItem(index, rowRef.current);
    return () => registerItem(index, null);
  }, [index, registerItem]);

  return (
    <div
      ref={rowRef}
      data-proximity-index={index}
      data-state={isSelected ? "checked" : "unchecked"}
      role={ariaRole ?? undefined}
      aria-checked={
        ariaRole === "radio" || ariaRole === "checkbox"
          ? !!aria["aria-checked"]
          : undefined
      }
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      onFocus={(e) => {
        if ((e.target as HTMLElement).matches(":focus-visible")) {
          onFocusVisible();
        }
      }}
      onBlur={onBlurAny}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn(
        "relative z-10 flex min-h-10 cursor-pointer select-none gap-3 py-1.5 pl-3 pr-1.5 outline-none",
        // items-start when the body may exceed one line so the chip tracks
        // the first line instead of sliding to the row's vertical centre.
        topAlign ? "items-start" : "items-center",
        SHAPE_ITEM,
      )}
    >
      {/* Selected background is drawn at the container level so contiguous
          selections can merge into a single block. Row keeps z-10 above it. */}

      {/* Body — fills row */}
      <span className="inline-flex min-w-0 flex-1 items-center text-[13px] leading-snug">
        {children}
      </span>

      {/* Chip slot — a fixed 28×28 cell holding the chip number. When
          topAlign is on, the slot floats up so the chip's centre lines up
          with the centre of the first text line. The single-select submit
          arrow overlays it on hover/focus. */}
      <span
        className={cn(
          "relative inline-flex h-7 w-7 shrink-0 items-center justify-center",
          topAlign && "-mt-[5px]",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute inline-flex h-5 w-5 items-center justify-center text-[11px]",
            chipFilled ? "font-semibold" : "font-medium",
            isMulti && SHAPE_BG,
            isMulti
              ? chipFilled
                ? "bg-foreground text-background"
                : "border border-border text-muted-foreground"
              : chipFilled
                ? "text-foreground"
                : "text-muted-foreground",
            showArrow && "opacity-0",
          )}
        >
          {chipContent}
        </span>
        <AnimatePresence>
          {showArrow && (
            <motion.span
              aria-hidden={!onArrowClick}
              role={onArrowClick ? "button" : undefined}
              onClick={
                onArrowClick
                  ? (e) => {
                      e.stopPropagation();
                      onArrowClick();
                    }
                  : undefined
              }
              className={cn(
                "absolute inset-0 inline-flex items-center justify-center bg-foreground text-background",
                SHAPE_BG,
                onArrowClick && "cursor-pointer",
              )}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{
                opacity: 0,
                scale: 0.6,
                transition: { duration: 0.06 },
              }}
              transition={{
                ...SPRING_FAST,
                opacity: { duration: 0.08 },
              }}
            >
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </div>
  );
}
