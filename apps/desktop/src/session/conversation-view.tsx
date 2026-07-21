import { useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import {
  Check,
  CheckSquare,
  ChevronDown,
  Copy,
  Edit,
  Eye,
  FileText,
  Folder,
  GitBranch,
  Globe,
  Hammer,
  ImageIcon,
  MessageSquare,
  RefreshCw,
  Search,
  Terminal,
} from "lucide-react";
import type {
  KeyboardEvent,
  MouseEvent,
  MutableRefObject,
  ReactNode,
} from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentAskUserQuestionTool } from "./components/agent-ask-user-question-tool";
import { BrailleSpinner } from "./components/braille-spinner";
import { Markdown } from "./components/markdown";
import RawLogText from "./components/raw-log-text";
import { TextShimmer } from "./components/text-shimmer";
import { ThinkingStep, ThinkingSteps } from "./components/thinking-steps";
import { useConversationActions } from "./conversation-actions";
import { useImageMetadata } from "./hooks/use-image-metadata";
import type {
  CommandRunResult,
  DisplayEntry,
  FileChange,
  NormalizedEntry,
  ToolStatus,
} from "./types";
import {
  type ImageEntry,
  parseContextFromContent,
  shortSessionId,
} from "./types/context";
import {
  type ConversationSegment,
  type ThinkingStepsSegment,
  segmentConversationEntries,
} from "./utils/agent-step-segments";
import { SESSION_SELECT_TEXT_ATTR } from "./utils/session-select-all";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const COLLAPSED_HEIGHT = 192; // 12rem = 48 * 4px

interface ExpandableUserMessageProps {
  children: ReactNode;
  dataUserMessageId: string;
  /**
   * Hover-revealed actions (timestamp + copy) rendered below the bubble,
   * outside the collapsible region so they stay reachable for long messages.
   */
  footer?: ReactNode;
}

const ExpandableUserMessage = ({
  children,
  dataUserMessageId,
  footer,
}: ExpandableUserMessageProps) => {
  const [expanded, setExpanded] = useState(false);
  const [needsExpansion, setNeedsExpansion] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const checkHeight = () => {
      setNeedsExpansion(el.scrollHeight > COLLAPSED_HEIGHT);
    };

    checkHeight();

    const observer = new ResizeObserver(checkHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      data-user-message-id={dataUserMessageId}
      className="sticky -top-5 z-10 w-full bg-background pt-5"
    >
      <div className="group/message mx-auto w-full max-w-2xl">
        <div
          ref={contentRef}
          className={cn(
            "relative transition-[max-height] duration-200 ease-out",
            !expanded && needsExpansion && "overflow-hidden",
          )}
          style={{
            maxHeight: expanded || !needsExpansion ? "none" : COLLAPSED_HEIGHT,
          }}
        >
          <div className="pb-2">{children}</div>
          {!expanded && needsExpansion && (
            <div
              className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background via-background/80 to-transparent cursor-pointer flex items-end justify-center pb-1"
              onClick={() => setExpanded(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                if (e.key === "Enter" || e.key === " ") {
                  setExpanded(true);
                }
              }}
            >
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </div>
          )}
        </div>
        {expanded && needsExpansion && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="w-full flex items-center justify-center py-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown className="h-4 w-4 rotate-180" />
          </button>
        )}
        {footer}
      </div>
    </div>
  );
};

const formatMessageTime = (timestamp?: string | null): string | null => {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
};

/** Resolve the text a copy button should place on the clipboard for a user
 * message: the human-readable prompt with internal context markup stripped. */
const resolveUserCopyText = (content: string): string => {
  const { text } = parseContextFromContent(content);
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : content;
};

interface MessageActionsProps {
  /** Exact text the copy button writes to the clipboard. */
  copyText: string;
  /** ISO timestamp; rendered as a clock time when present, hidden otherwise. */
  timestamp?: string | null;
  /** Horizontal alignment within the message column. */
  align?: "start" | "end";
  /** Branch the conversation from this point into a new session. Omitted where
   * there is no point to branch from (a turn still running, or a session the
   * caller cannot fork). */
  onFork?: () => void;
}

/**
 * Hover-revealed metadata row shown below a chat message: the time it was sent
 * plus a copy button. The row reserves its own height and only fades in on
 * hover (responding to a `group/message` ancestor), so revealing it never
 * shifts the conversation. Reused for both user and assistant messages.
 */
const MessageActions = ({
  copyText,
  timestamp,
  align = "end",
  onFork,
}: MessageActionsProps) => {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);
  const time = formatMessageTime(timestamp);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
    } catch (error) {
      console.warn("[message-actions] copy failed", error);
    }
  }, [copyText]);

  const copyLabel = copied ? t("copied") : t("copyMessage");

  return (
    <div
      className={cn(
        "flex h-6 items-center gap-2 px-1 text-muted-foreground opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      {time && (
        <span className="text-[11px] leading-none tabular-nums">{time}</span>
      )}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleCopy}
              aria-label={copyLabel}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-custom-sidebar-background-80 hover:text-foreground"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{copyLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {/* Icon only, like every other action here: the label belongs in the
          tooltip, not in a banner across the conversation. */}
      {onFork ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onFork}
                aria-label={t("continueFromHere")}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-custom-sidebar-background-80 hover:text-foreground"
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("continueFromHere")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </div>
  );
};

const renderStructuredValue = (value: unknown): ReactNode => {
  if (value === null) {
    return <span className="text-muted-foreground">null</span>;
  }
  if (value === undefined) {
    return <span className="text-muted-foreground">undefined</span>;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return <span className="text-muted-foreground">&quot;&quot;</span>;
    }
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        return renderStructuredValue(parsed);
      } catch {
        // fall through when JSON.parse fails
      }
    }
    if (value.includes("\n")) {
      const [firstLine = "", ...restLines] = value.split(/\r?\n/);
      const rest = restLines.join("\n").trim();
      if (
        rest.length > 0 &&
        ((rest.startsWith("{") && rest.endsWith("}")) ||
          (rest.startsWith("[") && rest.endsWith("]")))
      ) {
        try {
          const parsed = JSON.parse(rest);
          return (
            <div className="flex flex-col gap-2">
              {firstLine.trim().length > 0 && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {firstLine}
                </span>
              )}
              {renderStructuredValue(parsed)}
            </div>
          );
        } catch {
          // ignore parse error and render raw string instead
        }
      }
      return (
        <pre className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded border border-border/40 bg-background/60 px-2 py-1 font-mono text-[11px] text-foreground">
          {value}
        </pre>
      );
    }
    return (
      <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono text-[11px] text-foreground">
        {value}
      </span>
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return (
      <span className="font-mono text-[11px] text-foreground">
        {String(value)}
      </span>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">[]</span>;
    }
    return (
      <div className="flex flex-col gap-1">
        {value.map((item, index) => (
          <div
            key={index}
            className="rounded border border-border/40 bg-background/60 px-2 py-1"
          >
            {renderStructuredValue(item)}
          </div>
        ))}
      </div>
    );
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return <span className="text-muted-foreground">{`{}`}</span>;
    }
    return (
      <div className="flex flex-col gap-1">
        {entries.map(([key, val]) => (
          <div key={key} className="flex items-baseline gap-3">
            <span className="min-w-[88px] shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
              {key}
            </span>
            <div className="min-w-0 flex-1">{renderStructuredValue(val)}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <pre className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded border border-border/40 bg-background/60 px-2 py-1 font-mono text-[11px] text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
};

type CardVariant = "system" | "error";

type MessageCardProps = {
  children: ReactNode;
  variant: CardVariant;
  expanded?: boolean;
  onToggle?: () => void;
};

const MessageCard = ({
  children,
  variant,
  expanded,
  onToggle,
}: MessageCardProps) => {
  const systemTheme =
    "flex min-w-0 w-full items-center gap-1.5 text-muted-foreground";
  const errorTheme =
    "flex min-w-0 w-full items-start gap-1.5 text-sm leading-relaxed text-destructive";

  return (
    <div
      className={cn(variant === "system" ? systemTheme : errorTheme)}
      onClick={onToggle}
      role={onToggle ? "button" : undefined}
    >
      <div className="min-w-0 flex-1 overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {children}
      </div>
      {onToggle && (
        <ExpandChevron
          expanded={!!expanded}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          variant={variant}
        />
      )}
    </div>
  );
};

type ExpandChevronProps = {
  expanded: boolean;
  onClick: (event: MouseEvent) => void;
  variant: CardVariant;
};

const ExpandChevron = ({ expanded, onClick, variant }: ExpandChevronProps) => (
  <ChevronDown
    onClick={onClick}
    className={cn(
      "h-4 w-4 shrink-0 cursor-pointer transition-transform duration-150 ease-out",
      expanded ? "" : "-rotate-90",
      variant === "system"
        ? "text-muted-foreground"
        : "text-red-500 dark:text-red-400",
    )}
  />
);

type CollapsibleEntryProps = {
  content: string;
  markdown?: boolean;
  variant: CardVariant;
};

const CollapsibleEntry = ({
  content,
  markdown = false,
  variant,
}: CollapsibleEntryProps) => {
  const [expanded, setExpanded] = useState(false);
  const multiline = content.includes("\n");

  const renderContent = (value: string) =>
    markdown ? <Markdown>{value}</Markdown> : value;

  if (!multiline) {
    return (
      <MessageCard variant={variant}>{renderContent(content)}</MessageCard>
    );
  }

  if (expanded) {
    return (
      <MessageCard
        variant={variant}
        expanded
        onToggle={() => setExpanded(false)}
      >
        {renderContent(content)}
      </MessageCard>
    );
  }

  const firstLine = content.split("\n")[0] ?? content;
  return (
    <MessageCard
      variant={variant}
      expanded={false}
      onToggle={() => setExpanded(true)}
    >
      {renderContent(firstLine)}
    </MessageCard>
  );
};

/**
 * Error entry for a turn that aborted on a malformed tool call. Explains the
 * (intermittent, model-side) failure and offers a one-click retry that
 * re-prompts the agent to continue. The retry action comes from context, so it
 * is hidden on surfaces that cannot send follow-ups (e.g. read-only replay).
 */
const MalformedToolCallEntry = ({ content }: { content: string }) => {
  const { t } = useLanguage();
  const { onRetryMalformedToolCall } = useConversationActions();
  return (
    <div className="flex flex-col gap-2">
      <CollapsibleEntry content={content} markdown variant="error" />
      {onRetryMalformedToolCall && (
        <button
          type="button"
          onClick={onRetryMalformedToolCall}
          className="inline-flex items-center gap-1.5 self-start rounded border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t("retryMalformedToolCall")}
        </button>
      )}
    </div>
  );
};

/**
 * Error entry for a turn that ended on a server-side API error (rate limit,
 * usage limit, ...). Shows the CLI's own message and offers a one-click retry
 * that re-prompts the agent to continue. The retry action comes from context,
 * so it is hidden on surfaces that cannot send follow-ups (e.g. read-only
 * replay).
 */
const ApiErrorEntry = ({ content }: { content: string }) => {
  const { t } = useLanguage();
  const { onRetryApiError } = useConversationActions();
  return (
    <div className="flex flex-col gap-2">
      <CollapsibleEntry content={content} markdown variant="error" />
      {onRetryApiError && (
        <button
          type="button"
          onClick={onRetryApiError}
          className="inline-flex items-center gap-1.5 self-start rounded border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t("retryApiError")}
        </button>
      )}
    </div>
  );
};

type AgentThinkingStepsProps = {
  segment: ThinkingStepsSegment;
  onFilePathClick?: (path: string) => void;
};

/**
 * Renders one run of agent working entries (thinking, tool calls, loading)
 * as a thinking-steps timeline. The header shows what the agent is doing
 * (latest step summary) and shimmers while the run is live. The timeline
 * stays collapsed until the user opens it; the one exception is a tool
 * waiting for approval, which forces it open so the prompt is reachable.
 */
const AgentThinkingSteps = ({
  segment,
  onFilePathClick,
}: AgentThinkingStepsProps) => {
  const { t } = useLanguage();
  const { entries, live, awaitingApproval } = segment;
  const [open, setOpen] = useState(awaitingApproval);
  const userToggledRef = useRef(false);

  useEffect(() => {
    if (awaitingApproval && !userToggledRef.current) {
      setOpen(true);
    }
  }, [awaitingApproval]);

  const handleOpenChange = (next: boolean) => {
    userToggledRef.current = true;
    setOpen(next);
  };

  return (
    <ThinkingSteps
      label={segment.label ?? t("thinkingLabel")}
      active={live}
      open={open}
      onOpenChange={handleOpenChange}
      className="px-2"
    >
      {entries.map((displayEntry, index) => {
        const entry = displayEntry.content;
        const isLast = index === entries.length - 1;
        const entryType = entry.entry_type.type;

        if (entryType === "tool_use") {
          return (
            <ThinkingStep
              key={displayEntry.key}
              icon={toolIcon(entry)}
              animateIn={live}
              isLast={isLast}
            >
              <ToolCallEntryContent
                entry={entry as ToolUseEntry}
                onFilePathClick={onFilePathClick}
              />
            </ThinkingStep>
          );
        }

        if (entryType === "loading") {
          return (
            <ThinkingStep
              key={displayEntry.key}
              icon={
                // Braille spinner frames use only the upper 6 dots, leaving the
                // glyph's bottom cell row empty, so the ink rides high in its
                // line box. Nudge down 2px to optically center it on the text.
                <BrailleSpinner className="translate-y-[2px] text-[13px] text-muted-foreground/90" />
              }
              animateIn={live}
              isLast={isLast}
            >
              <TextShimmer className="text-[13px] font-medium text-muted-foreground/90">
                {entry.content || t("processingPlaceholder")}
              </TextShimmer>
            </ThinkingStep>
          );
        }

        return (
          <ThinkingStep key={displayEntry.key} animateIn={live} isLast={isLast}>
            <div className="text-[13px] text-muted-foreground">
              <Markdown tone="muted">{entry.content}</Markdown>
            </div>
          </ThinkingStep>
        );
      })}
    </ThinkingSteps>
  );
};

type PlanAppearance = "default" | "denied" | "timed_out";

const PLAN_APPEARANCE: Record<
  PlanAppearance,
  {
    border: string;
    headerBg: string;
    headerText: string;
    contentBg: string;
    contentText: string;
  }
> = {
  default: {
    border: "border-blue-400/40",
    headerBg: "bg-blue-50 dark:bg-blue-950/50",
    headerText: "text-blue-700 dark:text-blue-300",
    contentBg: "bg-blue-50 dark:bg-blue-950/50",
    contentText: "text-blue-700 dark:text-blue-300",
  },
  denied: {
    border: "border-red-400/40",
    headerBg: "bg-red-50 dark:bg-red-950/50",
    headerText: "text-red-700 dark:text-red-300",
    contentBg: "bg-red-50 dark:bg-red-950/50",
    contentText: "text-red-700 dark:text-red-300",
  },
  timed_out: {
    border: "border-amber-400/40",
    headerBg: "bg-amber-50 dark:bg-amber-950/50",
    headerText: "text-amber-700 dark:text-amber-300",
    contentBg: "bg-amber-50 dark:bg-amber-950/50",
    contentText: "text-amber-700 dark:text-amber-300",
  },
};

type PlanPresentationCardProps = {
  plan: string;
  appearance: PlanAppearance;
};

const PlanPresentationCard = ({
  plan,
  appearance,
}: PlanPresentationCardProps) => {
  const [expanded, setExpanded] = useState(false);
  const tone = PLAN_APPEARANCE[appearance];
  const { t } = useLanguage();

  return (
    <div className="inline-block w-full">
      <div className={cn("w-full overflow-hidden rounded border", tone.border)}>
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className={cn(
            "flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-semibold",
            tone.headerBg,
            tone.headerText,
          )}
        >
          <span className="flex-1">{t("planLabel")}</span>
          <ChevronDown
            className={cn(
              "h-4 w-4 transition-transform duration-150 ease-out",
              expanded ? "" : "-rotate-90",
            )}
          />
        </button>
        {expanded && (
          <div
            className={cn(
              "px-3 py-2 text-xs",
              tone.contentBg,
              tone.contentText,
            )}
          >
            <Markdown>{plan}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
};

type DiffLineProps = {
  line: string;
};

const DiffLine = ({ line }: DiffLineProps) => {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return (
      <div className="bg-green-500/10 border-l-2 border-l-green-500/50 pl-2 text-green-700 dark:text-green-300">
        {line}
      </div>
    );
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return (
      <div className="bg-red-500/10 border-l-2 border-l-red-500/50 pl-2 text-red-700 dark:text-red-300">
        {line}
      </div>
    );
  }
  if (line.startsWith("@@")) {
    return (
      <div className="bg-blue-500/5 text-muted-foreground pl-2">{line}</div>
    );
  }
  return <div className="pl-2 text-foreground/80">{line}</div>;
};

type UnifiedDiffViewProps = {
  diff: string;
};

const UnifiedDiffView = ({ diff }: UnifiedDiffViewProps) => {
  // Handle both \n and \r\n line endings
  const lines = diff.split(/\r?\n/);
  return (
    <div className="max-h-64 overflow-auto rounded bg-muted/30 py-2 text-xs font-mono">
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
    </div>
  );
};

type FileChangesListProps = {
  path: string;
  changes: FileChange[];
};

const FileChangesList = ({ path, changes }: FileChangesListProps) => {
  if (!changes.length) return null;

  return (
    <div className="space-y-3">
      {changes.map((change, index) => {
        const key = `${path}-${index}`;

        if (change.action === "edit") {
          return (
            <div key={key} className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {path}
              </p>
              <UnifiedDiffView diff={change.unified_diff} />
            </div>
          );
        }

        if (change.action === "write") {
          return (
            <div key={key} className="space-y-1">
              <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                + {path}
              </p>
              <pre className="max-h-64 overflow-auto bg-green-500/5 border-l-2 border-l-green-500/50 p-3 text-xs font-mono whitespace-pre-wrap text-foreground/80">
                {change.content}
              </pre>
            </div>
          );
        }

        if (change.action === "delete") {
          return (
            <p key={key} className="text-xs text-red-600 dark:text-red-400">
              − Deleted {path}
            </p>
          );
        }

        if (change.action === "rename") {
          return (
            <p key={key} className="text-xs text-blue-600 dark:text-blue-400">
              → Renamed {path} → {change.new_path}
            </p>
          );
        }

        return null;
      })}
    </div>
  );
};

const toolIcon = (entry: NormalizedEntry): ReactNode => {
  if (entry.entry_type.type !== "tool_use")
    return <Hammer className="h-3 w-3" />;
  const action = entry.entry_type.action_type;
  switch (action.action) {
    case "command_run":
      return <Terminal className="h-3 w-3" />;
    case "file_read":
      return <Eye className="h-3 w-3" />;
    case "file_edit":
      return <Edit className="h-3 w-3" />;
    case "todo_management":
      return <CheckSquare className="h-3 w-3" />;
    case "web_fetch":
      return <Globe className="h-3 w-3" />;
    case "search":
      return <Search className="h-3 w-3" />;
    case "plan_presentation":
      return <CheckSquare className="h-3 w-3" />;
    default:
      return <Hammer className="h-3 w-3" />;
  }
};

const getEntryWrapperClasses = (entry: NormalizedEntry) => {
  const base = "flex min-w-0 max-w-full flex-col gap-3 px-4 py-1";
  switch (entry.entry_type.type) {
    case "user_message":
      return `${base} rounded-md bg-custom-sidebar-background-80`;
    case "assistant_message":
      return `${base}`;
    case "system_message": {
      // Compact style for model info
      const isModelInfo = /^Run with .+/.test(entry.content);
      if (isModelInfo) {
        return "px-4 py-1.5";
      }
      return `${base} text-sm text-muted-foreground`;
    }
    case "error_message":
      return `${base} rounded border border-destructive/40 bg-destructive/10 text-destructive`;
    default:
      return `${base}`;
  }
};

const getCommandExitStatusTone = (
  exitStatus: CommandRunResult["exit_status"],
): string => {
  if (!exitStatus) {
    return "bg-muted text-muted-foreground border-border";
  }
  if (exitStatus.type === "exit_code") {
    return exitStatus.code === 0
      ? "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800"
      : "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800";
  }
  if (exitStatus.type === "success") {
    return exitStatus.success
      ? "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800"
      : "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800";
  }
  return "bg-muted text-muted-foreground border-border";
};

type ToolUseEntry = NormalizedEntry & {
  entry_type: Extract<NormalizedEntry["entry_type"], { type: "tool_use" }>;
};

const toolStatusTone = (status: ToolStatus): string => {
  switch (status.status) {
    case "success":
      return "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800";
    case "failed":
    case "denied":
      return "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800";
    case "pending_approval":
      return "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-800";
    case "timed_out":
      return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800";
    case "created":
    default:
      return "bg-muted text-muted-foreground border-border";
  }
};

type ToolCallEntryContentProps = {
  entry: ToolUseEntry;
  onFilePathClick?: (path: string) => void;
};

const ToolCallEntryContent = ({
  entry,
  onFilePathClick,
}: ToolCallEntryContentProps) => {
  const { action_type: action, status, tool_name } = entry.entry_type;
  const { t } = useLanguage();

  const shouldDefaultExpand =
    action.action === "command_run" &&
    (status.status === "failed" ||
      status.status === "denied" ||
      status.status === "timed_out");

  const [expanded, setExpanded] = useState(shouldDefaultExpand);

  useEffect(() => {
    setExpanded(shouldDefaultExpand);
  }, [shouldDefaultExpand]);

  if (action.action === "plan_presentation") {
    let appearance: PlanAppearance = "default";
    if (status.status === "denied") appearance = "denied";
    if (status.status === "timed_out") appearance = "timed_out";
    return <PlanPresentationCard plan={action.plan} appearance={appearance} />;
  }

  // Handle AskUserQuestion tool
  if (tool_name === "AskUserQuestion" && action.action === "tool") {
    const input = action.arguments as {
      questions?: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string }>;
        multiSelect: boolean;
      }>;
    };
    const result = action.result?.value as
      | { answers?: Record<string, string> }
      | string
      | undefined;
    const isError = status.status === "failed" || status.status === "denied";
    const isPending = status.status === "pending_approval";
    const toolCallId =
      status.status === "pending_approval"
        ? (status as { approval_id?: string }).approval_id
        : entry.id;

    return (
      <AgentAskUserQuestionTool
        input={input}
        result={result}
        state={isPending ? "call" : "result"}
        isError={isError}
        isStreaming={isPending}
        toolCallId={toolCallId}
      />
    );
  }

  const label = tool_name || t("commandPreviewFallback");
  const rawContent = (entry.content || "").trim();
  const contentLines = rawContent
    ? rawContent.split(/\r?\n/).map((line) => line.trim())
    : [];
  const firstContentLine = contentLines.find(
    (line) => line && !line.startsWith("[Tool]"),
  );
  const fallbackContentLine =
    contentLines[0] && !contentLines[0]!.startsWith("[Tool]")
      ? contentLines[0]
      : "";
  const isSingleLineContent = rawContent !== "" && !/\r?\n/.test(rawContent);
  const inlineSummary = (() => {
    if (action.action === "command_run") {
      return null;
    }
    if (action.action === "file_edit" || action.action === "file_read") {
      return action.path ?? null;
    }
    if (!isSingleLineContent) {
      return null;
    }
    const candidate = firstContentLine || fallbackContentLine || "";
    const trimmedCandidate = candidate.trim();
    if (trimmedCandidate === "{" || trimmedCandidate === "[") {
      return null;
    }
    return candidate || null;
  })();
  const showInlineSummary =
    action.action !== "command_run" && Boolean(inlineSummary);

  const commandResult =
    action.action === "command_run"
      ? (action.result as CommandRunResult | null)
      : null;
  const commandText =
    action.action === "command_run" ? (action.command ?? "").trim() : "";
  const commandLines = commandText ? commandText.split(/\r?\n/) : [];
  const commandPreview =
    action.action === "command_run"
      ? commandLines.find((line) => line.trim().length > 0) ?? ""
      : "";
  const commandHasMoreLines =
    action.action === "command_run" && commandText.includes("\n");
  const commandOutput =
    action.action === "command_run" ? commandResult?.output ?? null : null;
  const outputPreview =
    action.action === "command_run" && typeof commandOutput === "string"
      ? commandOutput
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? ""
      : "";
  const secondaryCommandLine =
    action.action === "command_run"
      ? outputPreview || firstContentLine || fallbackContentLine || ""
      : "";

  const hasCommandDetails =
    action.action === "command_run" &&
    (Boolean(commandText) ||
      Boolean(commandResult?.output) ||
      Boolean(commandResult?.exit_status) ||
      contentLines.some((line) => line && !line.startsWith("[Tool]")));

  const hasToolDetails =
    action.action === "tool" &&
    (action.arguments != null || action.result != null);

  const hasFileChanges =
    action.action === "file_edit" ? (action.changes?.length ?? 0) > 0 : false;

  const canExpand =
    hasCommandDetails ||
    hasToolDetails ||
    hasFileChanges ||
    action.action === "todo_management";

  const toggle = () => setExpanded((prev) => !prev);

  const exitStatusLabel =
    action.action === "command_run"
      ? (() => {
          const exitStatus = commandResult?.exit_status ?? null;
          if (!exitStatus) return null;
          if (exitStatus.type === "exit_code") {
            return t("commandExitCodeLabel", { code: exitStatus.code });
          }
          if (exitStatus.type === "success") {
            return exitStatus.success ? t("statusSuccess") : t("statusFailed");
          }
          return null;
        })()
      : null;
  const exitStatusTone =
    action.action === "command_run"
      ? getCommandExitStatusTone(commandResult?.exit_status ?? null)
      : "";
  const statusText = (() => {
    switch (status.status) {
      case "created":
        return t("statusCreated");
      case "success":
        return t("statusSuccess");
      case "failed":
        return t("statusFailed");
      case "denied":
        return t("statusDenied");
      case "pending_approval":
        return t("statusPending");
      case "timed_out":
        return t("statusTimedOut");
      default:
        return t("statusDefault");
    }
  })();

  const renderDetails = () => {
    if (!expanded) return null;

    if (action.action === "command_run") {
      const sections: ReactNode[] = [];
      const renderSection = (title: string, body: ReactNode) => (
        <>
          <div className="bg-muted/40 px-3 py-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            {title}
          </div>
          <div className="px-3 py-2">{body}</div>
        </>
      );

      if (commandText) {
        sections.push(
          renderSection(
            t("commandLabel"),
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono text-xs text-foreground">
              {commandText}
            </pre>,
          ),
        );
      }

      if (typeof commandOutput === "string") {
        if (commandOutput.trim().length > 0) {
          sections.push(
            renderSection(
              t("outputLabel"),
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono text-xs text-foreground">
                {commandOutput}
              </pre>,
            ),
          );
        } else {
          sections.push(
            renderSection(
              t("outputLabel"),
              <span className="text-muted-foreground">
                {t("emptyCommandOutput")}
              </span>,
            ),
          );
        }
      }

      if (commandResult?.exit_status) {
        const statusLabel = (() => {
          const exitStatus = commandResult.exit_status;
          if (exitStatus.type === "exit_code") {
            return t("commandExitCodeLabel", { code: exitStatus.code });
          }
          if (exitStatus.type === "success") {
            return exitStatus.success ? t("statusSuccess") : t("statusFailed");
          }
          return null;
        })();
        if (statusLabel) {
          sections.push(
            renderSection(
              t("statusLabel"),
              <span className="text-xs text-muted-foreground">
                {statusLabel}
              </span>,
            ),
          );
        }
      }

      if (sections.length === 0) {
        return null;
      }

      return (
        <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border/50">
          {sections.map((section, index) => (
            <div key={`command-section-${index}`}>{section}</div>
          ))}
        </div>
      );
    }

    if (action.action === "file_edit") {
      return (
        <FileChangesList path={action.path} changes={action.changes ?? []} />
      );
    }

    if (action.action === "file_read") {
      return (
        <div className="max-h-64 overflow-auto rounded bg-muted/20 p-3 text-xs">
          <pre className="whitespace-pre-wrap text-foreground/90">
            {entry.content}
          </pre>
        </div>
      );
    }

    if (action.action === "todo_management") {
      return (
        <div className="rounded border border-border bg-background">
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("todosLabel")}
          </div>
          <ul className="divide-y divide-border border-t border-border">
            {action.todos.map((todo, index) => (
              <li
                key={index}
                className="flex items-center gap-2 px-3 py-1.5 text-xs"
              >
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px]">
                  {todo.status === "done" ? "✓" : ""}
                </span>
                <span className="flex-1 break-words">{todo.content}</span>
                <span className="text-muted-foreground/80">{todo.status}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    }

    if (action.action === "tool") {
      return (
        <div className="rounded border border-border">
          {action.arguments != null && (
            <div>
              <div className="bg-muted/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("argumentsLabel")}
              </div>
              <div className="px-3 py-2">
                {renderStructuredValue(action.arguments)}
              </div>
            </div>
          )}
          {action.result != null && (
            <div>
              <div className="bg-muted/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("resultLabel")}
              </div>
              <div className="px-3 py-2">
                {renderStructuredValue(action.result.value ?? action.result)}
              </div>
            </div>
          )}
        </div>
      );
    }

    return null;
  };

  const summaryText = (() => {
    if (action.action === "command_run" && commandPreview) {
      return `$ ${commandPreview}${commandHasMoreLines ? " …" : ""}`;
    }
    if (showInlineSummary && inlineSummary) {
      return inlineSummary;
    }
    return null;
  })();

  const filePathTarget =
    (action.action === "file_read" || action.action === "file_edit") &&
    typeof action.path === "string" &&
    action.path.length > 0
      ? action.path
      : null;
  const handleFilePathClick = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (filePathTarget && onFilePathClick) {
      onFilePathClick(filePathTarget);
    }
  };
  const isClickablePathSummary =
    Boolean(filePathTarget) &&
    Boolean(onFilePathClick) &&
    summaryText === filePathTarget;

  const handleHeaderKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (
    event,
  ) => {
    if (!canExpand) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div
        onClick={canExpand ? toggle : undefined}
        onKeyDown={handleHeaderKeyDown}
        role={canExpand ? "button" : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-expanded={canExpand ? expanded : undefined}
        className={cn(
          "flex min-w-0 items-center gap-2 text-left text-[12px] text-muted-foreground",
          canExpand && "hover:text-foreground cursor-pointer",
          !canExpand && "cursor-default",
        )}
      >
        <span className="min-w-0 shrink font-medium">{label}</span>
        {summaryText &&
          (isClickablePathSummary ? (
            <span
              role="link"
              tabIndex={0}
              onClick={handleFilePathClick}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  handleFilePathClick(event);
                }
              }}
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-blue-600 hover:underline underline-offset-2 cursor-pointer"
              title={summaryText}
            >
              {summaryText}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
              {summaryText}
            </span>
          ))}
        {canExpand && (
          <ChevronDown
            className={cn(
              "h-3 w-3 shrink-0 ml-auto transition-transform",
              expanded ? "" : "-rotate-90",
            )}
          />
        )}
      </div>
      {action.action !== "command_run" &&
        !showInlineSummary &&
        inlineSummary && (
          <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
            {inlineSummary}
          </pre>
        )}
      {status.status === "pending_approval" && (
        <p className="text-[11px] text-muted-foreground">
          {t("pendingApprovalMessage", {
            timeout: status.timeout_at ?? "--",
          })}
        </p>
      )}
      {status.status === "denied" && status.reason && (
        <p className="whitespace-pre-wrap break-words text-[11px] text-destructive">
          {t("deniedReasonLabel")}: {status.reason}
        </p>
      )}
      {renderDetails()}
    </div>
  );
};

const ImagePill = ({ name, path }: ImageEntry) => {
  const { data: metadata } = useImageMetadata(path);
  const displayName = name || path.split("/").pop() || "image";

  return (
    <span className="group/img relative inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-600 dark:bg-blue-950 dark:text-blue-400">
      <ImageIcon className="h-3 w-3 shrink-0" />
      {displayName}
      {metadata?.exists && metadata.proxy_url && (
        <span className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 hidden rounded-xl border border-border bg-popover p-1 shadow-sm group-hover/img:block">
          <img
            src={metadata.proxy_url}
            alt={displayName}
            className="max-h-48 max-w-64 rounded object-contain"
            draggable={false}
          />
        </span>
      )}
    </span>
  );
};

export const UserMessageContent = ({ content }: { content: string }) => {
  const { contextEntries, skillEntries, imageEntries, text } =
    parseContextFromContent(content);

  const hasPills =
    contextEntries.length > 0 ||
    skillEntries.length > 0 ||
    imageEntries.length > 0;

  return (
    <div className="space-y-2">
      {hasPills && (
        <div className="flex flex-wrap gap-1.5">
          {contextEntries.map((entry) => {
            if (entry.kind === "session") {
              const display = shortSessionId(entry.taskId);
              return (
                <span
                  key={`session-${entry.taskId}`}
                  className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-600 dark:bg-blue-950 dark:text-blue-400"
                  title={`Session ${entry.taskId}`}
                >
                  <MessageSquare className="h-3 w-3 shrink-0" />
                  {display}
                </span>
              );
            }
            const displayName = entry.path.split("/").pop() || entry.path;
            const Icon = entry.isFile ? FileText : Folder;
            return (
              <span
                key={`file-${entry.path}`}
                className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-600 dark:bg-blue-950 dark:text-blue-400"
                title={entry.path}
              >
                <Icon className="h-3 w-3 shrink-0" />
                {displayName}
              </span>
            );
          })}
          {skillEntries.map((skill) => {
            const displayName = skill.name || skill.id;
            return (
              <span
                key={`skill-${skill.id}`}
                className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                title={skill.id}
              >
                <Hammer className="h-3 w-3 shrink-0" />#{displayName}
              </span>
            );
          })}
          {imageEntries.map((img) => (
            <ImagePill key={img.path} {...img} />
          ))}
        </div>
      )}
      {text && (
        <p
          className="whitespace-pre-wrap break-words text-sm font-medium leading-relaxed text-foreground"
          {...{ [SESSION_SELECT_TEXT_ATTR]: "true" }}
        >
          {text}
        </p>
      )}
    </div>
  );
};

const renderEntryBody = (
  entry: NormalizedEntry,
  onWikilinkClick?: (path: string, subpath?: string) => void,
  onFilePathClick?: (path: string) => void,
) => {
  switch (entry.entry_type.type) {
    case "user_message":
      return <UserMessageContent content={entry.content} />;
    case "assistant_message":
      return (
        <div {...{ [SESSION_SELECT_TEXT_ATTR]: "true" }}>
          <Markdown
            onWikilinkClick={onWikilinkClick}
            onFilePathClick={onFilePathClick}
          >
            {entry.content}
          </Markdown>
        </div>
      );
    case "system_message": {
      // Model info message (e.g., "Run with gpt-5.2-codex reasoning effort: high")
      const runWithMatch = entry.content.match(
        /^Run with (.+?)(?:\s+reasoning effort:\s*(.+))?$/,
      );
      if (runWithMatch) {
        const [, model, effort] = runWithMatch;
        return (
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span>Run with</span>
            <span className="font-medium">{model}</span>
            {effort && (
              <>
                <span>reasoning effort:</span>
                <span className="font-medium">{effort}</span>
              </>
            )}
          </div>
        );
      }
      return (
        <CollapsibleEntry content={entry.content} markdown variant="system" />
      );
    }
    case "error_message":
      if (entry.entry_type.error_type?.type === "malformed_tool_call") {
        return <MalformedToolCallEntry content={entry.content} />;
      }
      if (entry.entry_type.error_type?.type === "api_error") {
        return <ApiErrorEntry content={entry.content} />;
      }
      return (
        <CollapsibleEntry content={entry.content} markdown variant="error" />
      );
    case "user_feedback":
      return (
        <CollapsibleEntry content={entry.content} markdown variant="system" />
      );
    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
          {entry.content}
        </p>
      );
  }
};

type ConversationEntriesProps = {
  entries: DisplayEntry[];
  endRef?: MutableRefObject<HTMLDivElement | null> | null;
  onWikilinkClick?: (path: string, subpath?: string) => void;
  onFilePathClick?: (path: string) => void;
  scrollContainerRef?: MutableRefObject<HTMLDivElement | null>;
  onScrollAnchorWillAdjust?: () => void;
  onScrollAnchorAdjusted?: () => void;
  hasMoreHistory?: boolean;
  isLoadingMoreHistory?: boolean;
  onLoadMoreHistory?: () => Promise<void> | void;
  /**
   * When active (find-in-conversation open with a query), bypass tail
   * virtualization and mount every entry so off-screen matches are searchable.
   */
  searchActive?: boolean;
  /**
   * Like {@link searchActive}, bypass tail virtualization and mount every entry.
   * Set when the message-navigation rail needs to reach a turn that scrolled out
   * of the rendered window.
   */
  expandAll?: boolean;
  /** Branch the conversation from a given run into a new session. Rendered as a
   * per-turn action; omitted when the session cannot be forked. */
  onForkFromRun?: (runId: string) => void;
  /** Rendered inside the scroll container above everything else. Used for the
   * fork-origin block: inherited history sits above even the oldest own turn. */
  leading?: ReactNode;
};

const INITIAL_RENDER_COUNT = 120;
const LOAD_MORE_COUNT = 120;
const LOAD_MORE_THRESHOLD = 72;

export const ConversationEntries = memo(
  ({
    entries,
    endRef,
    onWikilinkClick,
    onFilePathClick,
    scrollContainerRef,
    onScrollAnchorWillAdjust,
    onScrollAnchorAdjusted,
    hasMoreHistory = false,
    isLoadingMoreHistory = false,
    onLoadMoreHistory,
    searchActive,
    expandAll,
    onForkFromRun,
    leading,
  }: ConversationEntriesProps) => {
    const { t } = useLanguage();

    // Stabilize callback identities so the per-group memo can hit even when
    // callers pass freshly-created closures on every render (e.g. inline
    // arrow functions capturing local state).
    const onWikilinkClickRef = useRef(onWikilinkClick);
    onWikilinkClickRef.current = onWikilinkClick;
    const hasWikilinkClick = onWikilinkClick !== undefined;
    const stableOnWikilinkClick = useMemo(
      () =>
        hasWikilinkClick
          ? (path: string, subpath?: string) =>
              onWikilinkClickRef.current?.(path, subpath)
          : undefined,
      [hasWikilinkClick],
    );

    const onFilePathClickRef = useRef(onFilePathClick);
    onFilePathClickRef.current = onFilePathClick;
    const hasFilePathClick = onFilePathClick !== undefined;
    const stableOnFilePathClick = useMemo(
      () =>
        hasFilePathClick
          ? (path: string) => onFilePathClickRef.current?.(path)
          : undefined,
      [hasFilePathClick],
    );
    const internalScrollRef = useRef<HTMLDivElement>(null);
    const prevVisibleEntriesLengthRef = useRef(entries.length);
    const prevFirstEntryKeyRef = useRef<string | null>(entries[0]?.key ?? null);
    const scrollAdjustRef = useRef<{
      prevScrollHeight: number;
      prevScrollTop: number;
    } | null>(null);
    const [visibleCount, setVisibleCount] = useState(() =>
      Math.min(entries.length, INITIAL_RENDER_COUNT),
    );

    const getScrollElement = useCallback(
      () => scrollContainerRef?.current ?? internalScrollRef.current,
      [scrollContainerRef],
    );

    const captureScrollAnchor = useCallback(() => {
      const scrollElement = getScrollElement();
      if (!scrollElement) return;

      onScrollAnchorWillAdjust?.();
      scrollAdjustRef.current = {
        prevScrollHeight: scrollElement.scrollHeight,
        prevScrollTop: scrollElement.scrollTop,
      };
    }, [getScrollElement, onScrollAnchorWillAdjust]);

    const handleLoadMoreHistory = useCallback(() => {
      if (visibleCount < entries.length) return;
      if (!hasMoreHistory || isLoadingMoreHistory || !onLoadMoreHistory) return;
      captureScrollAnchor();
      void onLoadMoreHistory();
    }, [
      captureScrollAnchor,
      entries.length,
      hasMoreHistory,
      isLoadingMoreHistory,
      onLoadMoreHistory,
      visibleCount,
    ]);

    // While searching, mount the whole conversation so matches in older,
    // virtualized-out entries are reachable. Anchor the viewport so prepending
    // older entries above the fold doesn't visibly shift the content (the
    // existing scroll-adjust effect consumes scrollAdjustRef on visibleCount
    // changes).
    useEffect(() => {
      if (!searchActive && !expandAll) return;
      if (visibleCount >= entries.length) return;
      captureScrollAnchor();
      setVisibleCount(entries.length);
    }, [
      captureScrollAnchor,
      searchActive,
      expandAll,
      entries.length,
      visibleCount,
    ]);

    useEffect(() => {
      const firstKey = entries[0]?.key ?? null;
      const prevLength = prevVisibleEntriesLengthRef.current;
      const prevFirstKey = prevFirstEntryKeyRef.current;
      const prevFirstKeyIndex =
        prevFirstKey === null
          ? -1
          : entries.findIndex((entry) => entry.key === prevFirstKey);
      const hasPrependedEntries =
        prevFirstKeyIndex > 0 && entries.length > prevLength;
      const hasReset =
        !hasPrependedEntries &&
        ((prevFirstKey && firstKey && prevFirstKey !== firstKey) ||
          entries.length < prevLength);

      if (hasPrependedEntries) {
        setVisibleCount((prev) =>
          Math.min(entries.length, prev + LOAD_MORE_COUNT),
        );
      } else if (hasReset) {
        setVisibleCount(Math.min(entries.length, INITIAL_RENDER_COUNT));
      } else if (entries.length > prevLength) {
        const delta = entries.length - prevLength;
        const isBulkLoad = delta > LOAD_MORE_COUNT;
        setVisibleCount((prev) => {
          // Streaming: small increments while user is already seeing all → follow tail
          if (prev >= prevLength && !isBulkLoad) {
            return entries.length;
          }
          // Bulk load (historic run): cap to avoid rendering thousands of DOM nodes
          return Math.min(entries.length, Math.max(prev, INITIAL_RENDER_COUNT));
        });
      } else if (entries.length === 0) {
        setVisibleCount(0);
      }

      prevVisibleEntriesLengthRef.current = entries.length;
      prevFirstEntryKeyRef.current = firstKey;
    }, [entries]);

    useEffect(() => {
      const scrollElement = getScrollElement();
      if (!scrollElement) return;

      const handleScroll = () => {
        if (scrollElement.scrollTop > LOAD_MORE_THRESHOLD) return;
        if (visibleCount >= entries.length) {
          handleLoadMoreHistory();
          return;
        }

        captureScrollAnchor();
        setVisibleCount((prev) =>
          Math.min(entries.length, prev + LOAD_MORE_COUNT),
        );
      };

      scrollElement.addEventListener("scroll", handleScroll);
      return () => {
        scrollElement.removeEventListener("scroll", handleScroll);
      };
    }, [
      entries.length,
      captureScrollAnchor,
      getScrollElement,
      handleLoadMoreHistory,
      visibleCount,
    ]);

    useEffect(() => {
      const pendingAdjust = scrollAdjustRef.current;
      if (!pendingAdjust) return;
      const scrollElement = getScrollElement();
      if (!scrollElement) return;

      const adjustScroll = () => {
        const nextScrollHeight = scrollElement.scrollHeight;
        const delta = nextScrollHeight - pendingAdjust.prevScrollHeight;
        scrollElement.scrollTop = pendingAdjust.prevScrollTop + delta;
        scrollAdjustRef.current = null;
        onScrollAnchorAdjusted?.();
      };

      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(adjustScroll);
      } else if (typeof queueMicrotask === "function") {
        queueMicrotask(adjustScroll);
      } else {
        setTimeout(adjustScroll, 0);
      }
    }, [getScrollElement, onScrollAnchorAdjusted, visibleCount]);

    const startIndex = Math.max(entries.length - visibleCount, 0);
    const visibleEntries = entries.slice(startIndex);
    const canLoadMoreHistory = hasMoreHistory && visibleCount >= entries.length;
    const historyLoader = canLoadMoreHistory ? (
      <div className="flex w-full justify-center pb-4">
        <button
          type="button"
          className="rounded-sm px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-custom-sidebar-background-80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          disabled={isLoadingMoreHistory}
          onClick={handleLoadMoreHistory}
        >
          {isLoadingMoreHistory
            ? t("loadingEarlierMessages")
            : t("loadEarlierMessages")}
        </button>
      </div>
    ) : null;

    // If no external scroll container, use internal wrapper
    if (!scrollContainerRef) {
      return (
        <div
          ref={internalScrollRef}
          className={cn(
            "flex w-full max-w-2xl flex-col mx-auto overflow-y-auto",
          )}
          style={{ height: "100%", contain: "strict" }}
        >
          {leading}
          {historyLoader}
          <EntryList
            entries={visibleEntries}
            onWikilinkClick={stableOnWikilinkClick}
            onFilePathClick={stableOnFilePathClick}
            endRef={endRef}
            onForkFromRun={onForkFromRun}
          />
        </div>
      );
    }

    return (
      <>
        {leading}
        {historyLoader}
        <EntryList
          entries={visibleEntries}
          onWikilinkClick={stableOnWikilinkClick}
          onFilePathClick={stableOnFilePathClick}
          endRef={endRef}
          onForkFromRun={onForkFromRun}
        />
      </>
    );
  },
);

interface EntryListProps {
  entries: DisplayEntry[];
  onWikilinkClick?: (path: string, subpath?: string) => void;
  onFilePathClick?: (path: string) => void;
  endRef?: MutableRefObject<HTMLDivElement | null> | null;
  onForkFromRun?: (runId: string) => void;
}

// Group entries by user message: each group starts with a user_message and includes
// all subsequent entries until the next user_message
type EntryGroup = {
  userEntry: DisplayEntry | null;
  followingEntries: DisplayEntry[];
  key: string;
};

/**
 * Grouping cache: reuses an `EntryGroup` object across renders when its
 * `userEntry` reference and `followingEntries` contents are unchanged.
 * This lets the memoized `<Group>` component skip rendering for every
 * conversation turn except the one currently streaming.
 */
type GroupingCache = (entries: DisplayEntry[]) => EntryGroup[];

function createGroupingCache(): GroupingCache {
  type CacheEntry = {
    group: EntryGroup;
    followingSnapshot: DisplayEntry[];
  };
  const cache = new Map<string, CacheEntry>();

  const reuseOrCommit = (candidate: EntryGroup): EntryGroup => {
    const cached = cache.get(candidate.key);
    if (
      cached &&
      cached.group.userEntry === candidate.userEntry &&
      cached.followingSnapshot.length === candidate.followingEntries.length
    ) {
      let same = true;
      for (let i = 0; i < cached.followingSnapshot.length; i++) {
        if (cached.followingSnapshot[i] !== candidate.followingEntries[i]) {
          same = false;
          break;
        }
      }
      if (same) return cached.group;
    }
    cache.set(candidate.key, {
      group: candidate,
      followingSnapshot: [...candidate.followingEntries],
    });
    return candidate;
  };

  return (entries: DisplayEntry[]): EntryGroup[] => {
    const groups: EntryGroup[] = [];
    let currentGroup: EntryGroup | null = null;

    for (const entry of entries) {
      const isUserMessage =
        entry.type === "NORMALIZED_ENTRY" &&
        entry.content.entry_type.type === "user_message";

      if (isUserMessage) {
        if (currentGroup) groups.push(reuseOrCommit(currentGroup));
        currentGroup = {
          userEntry: entry,
          followingEntries: [],
          key: entry.key,
        };
      } else if (currentGroup) {
        currentGroup.followingEntries.push(entry);
      } else {
        groups.push(
          reuseOrCommit({
            userEntry: null,
            followingEntries: [entry],
            key: entry.key,
          }),
        );
      }
    }

    if (currentGroup) groups.push(reuseOrCommit(currentGroup));

    const liveKeys = new Set<string>();
    for (const g of groups) liveKeys.add(g.key);
    for (const k of [...cache.keys()]) {
      if (!liveKeys.has(k)) cache.delete(k);
    }

    return groups;
  };
}

interface GroupProps {
  group: EntryGroup;
  onWikilinkClick?: (path: string, subpath?: string) => void;
  onFilePathClick?: (path: string) => void;
  /** Branch from the run this turn belongs to. Omitted when the session cannot
   * be forked (e.g. its worktree is gone). */
  onForkFromRun?: (runId: string) => void;
}

const Group = memo(
  ({ group, onWikilinkClick, onFilePathClick, onForkFromRun }: GroupProps) => {
    const userMessage =
      group.userEntry?.type === "NORMALIZED_ENTRY"
        ? group.userEntry.content
        : null;
    const turnTimestamp = userMessage?.timestamp ?? null;
    const segments = useMemo(
      () => segmentConversationEntries(group.followingEntries),
      [group],
    );
    // Only the final assistant message of a turn carries the actions row, so
    // intermediate replies (between tool calls) stay clean.
    let lastAssistantKey: string | null = null;
    for (let i = group.followingEntries.length - 1; i >= 0; i--) {
      const candidate = group.followingEntries[i];
      if (
        candidate?.type === "NORMALIZED_ENTRY" &&
        candidate.content.entry_type.type === "assistant_message"
      ) {
        lastAssistantKey = candidate.key;
        break;
      }
    }
    // Every entry key is `<runId>:<entryId>`, so the turn's own key already
    // says which run produced it — no separate plumbing needed to anchor a fork
    // at this point in the conversation.
    const anchorRunId = lastAssistantKey?.split(":")[0] ?? null;
    const forkFromThisTurn =
      onForkFromRun && anchorRunId
        ? () => onForkFromRun(anchorRunId)
        : undefined;
    return (
      <div className="relative">
        {group.userEntry && (
          <ExpandableUserMessage
            dataUserMessageId={group.key}
            footer={
              userMessage ? (
                <MessageActions
                  copyText={resolveUserCopyText(userMessage.content)}
                  timestamp={userMessage.timestamp}
                  align="start"
                />
              ) : null
            }
          >
            <EntryRenderer
              displayEntry={group.userEntry}
              onWikilinkClick={onWikilinkClick}
              onFilePathClick={onFilePathClick}
            />
          </ExpandableUserMessage>
        )}
        {segments.map((segment) => (
          <div key={segment.key} className="mx-auto w-full max-w-2xl">
            <div className="pb-2">
              {segment.type === "THINKING_STEPS" ? (
                <AgentThinkingSteps
                  segment={segment}
                  onFilePathClick={onFilePathClick}
                />
              ) : (
                <EntryRenderer
                  displayEntry={segment.entry}
                  onWikilinkClick={onWikilinkClick}
                  onFilePathClick={onFilePathClick}
                  messageTimestamp={turnTimestamp}
                  showActions={segment.key === lastAssistantKey}
                  onFork={
                    segment.key === lastAssistantKey
                      ? forkFromThisTurn
                      : undefined
                  }
                />
              )}
            </div>
          </div>
        ))}
      </div>
    );
  },
  (prev, next) =>
    prev.group === next.group &&
    prev.onWikilinkClick === next.onWikilinkClick &&
    prev.onFilePathClick === next.onFilePathClick &&
    prev.onForkFromRun === next.onForkFromRun,
);

export const EntryList = memo(
  ({
    entries,
    onWikilinkClick,
    onFilePathClick,
    endRef,
    onForkFromRun,
  }: EntryListProps) => {
    const groupingCacheRef = useRef<GroupingCache | null>(null);
    if (groupingCacheRef.current === null) {
      groupingCacheRef.current = createGroupingCache();
    }
    const groups = useMemo(() => groupingCacheRef.current!(entries), [entries]);

    return (
      <div className={cn("flex w-full flex-col")}>
        {groups.map((group) => (
          <Group
            key={group.key}
            onForkFromRun={onForkFromRun}
            group={group}
            onWikilinkClick={onWikilinkClick}
            onFilePathClick={onFilePathClick}
          />
        ))}
        <div
          ref={(node) => {
            if (endRef) {
              endRef.current = node;
            }
          }}
          className="h-px"
        />
      </div>
    );
  },
);

interface EntryRendererProps {
  displayEntry: DisplayEntry;
  onWikilinkClick?: (path: string, subpath?: string) => void;
  onFilePathClick?: (path: string) => void;
  /**
   * Fallback timestamp for assistant messages, taken from the turn's user
   * message (run creation time). The backend does not stamp individual
   * entries, so this is the closest available time for the exchange.
   */
  messageTimestamp?: string | null;
  /**
   * Whether this entry should render the hover actions row. Set only for the
   * final assistant message of a turn so intermediate replies stay clean.
   */
  showActions?: boolean;
  /** Branch the conversation from this turn. Only passed alongside
   * `showActions`, so it lands on the same final assistant message. */
  onFork?: () => void;
}

const EntryRenderer = memo(
  ({
    displayEntry,
    onWikilinkClick,
    onFilePathClick,
    messageTimestamp,
    showActions,
    onFork,
  }: EntryRendererProps) => {
    if (displayEntry.type === "STDOUT") {
      return (
        <RawLogText
          content={displayEntry.content}
          channel="stdout"
          className="text-sm px-4 py-1"
        />
      );
    }
    if (displayEntry.type === "STDERR") {
      return (
        <RawLogText
          content={displayEntry.content}
          channel="stderr"
          className="text-sm px-4 py-1"
        />
      );
    }

    // Handle NORMALIZED_ENTRY type
    const entry = displayEntry.content;

    // Guard against malformed entries
    if (!entry || !entry.entry_type) {
      console.warn("[ConversationEntries] Skipping malformed entry:", entry);
      return null;
    }
    const isAssistant = entry.entry_type.type === "assistant_message";
    const showAssistantActions = isAssistant && Boolean(showActions);

    return (
      <div
        className={cn(
          getEntryWrapperClasses(entry),
          showAssistantActions && "group/message",
        )}
      >
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-2">
            {renderEntryBody(entry, onWikilinkClick, onFilePathClick)}
            {showAssistantActions && (
              <MessageActions
                copyText={entry.content}
                timestamp={entry.timestamp ?? messageTimestamp}
                align="start"
                onFork={onFork}
              />
            )}
          </div>
        </div>
      </div>
    );
  },
);
