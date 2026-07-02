import type { TranslationFunction, TranslationKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { CollapsibleMessage } from "@/session/components/collapsible-message";
import { Markdown } from "@/session/components/markdown";
import { UserMessageContent } from "@/session/conversation-view";
import {
  type DateBucket,
  deriveDateBucket,
} from "@/session/domain/session-grouping";
import type { StoredTask } from "@/session/types";
import { taskApi } from "@/tasks/task-api";
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogPrimitive,
  DialogTitle,
} from "@chro/ui/dialog";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  CornerDownLeft,
  Loader2,
  MessageSquare,
  Search,
  SquarePen,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const MAX_SESSION_RESULTS = 50;
/** Cap the previewed reply so an enormous message doesn't render in full. */
const PREVIEW_MAX_CHARS = 2000;
/** Settle time before the preview follows the selection, so fast arrow-key
 * scrolling doesn't fire a fetch for every row it passes through. */
const PREVIEW_DEBOUNCE_MS = 120;

const BUCKET_ORDER: readonly DateBucket[] = [
  "today",
  "yesterday",
  "last7",
  "last30",
  "older",
];

const BUCKET_LABEL_KEY: Record<DateBucket, TranslationKey> = {
  today: "dateToday",
  yesterday: "dateYesterday",
  last7: "dateLast7",
  last30: "dateLast30",
  older: "dateOlder",
};

const truncate = (text: string): string =>
  text.length > PREVIEW_MAX_CHARS
    ? `${text.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`
    : text;

const matches = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle);

/** A single actionable row in the palette: either a command or a session. */
interface PaletteEntry {
  kind: "command" | "session";
  id: string;
  label: string;
  /** Secondary text (the session's project name). */
  detail?: string | null;
  icon: ReactNode;
  /** Present for session entries; backs the preview pane. */
  task?: StoredTask;
  run: () => void;
}

/** A labelled run of entries in the list (Commands / a date bucket / results). */
interface PaletteSection {
  id: string;
  heading: string;
  entries: PaletteEntry[];
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Searchable sessions, already ordered most-recent-first. */
  sessions: StoredTask[];
  /** Resolves a task's `project_id` to a display name. */
  projectName: (projectId: string) => string | null;
  onNewChat: () => void;
  onOpenSession: (task: StoredTask) => void;
  t: TranslationFunction;
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/**
 * Left-panel command palette: a wide two-pane modal that blends a session
 * search with a small set of commands (e.g. "New chat"). The left pane lists
 * matches grouped by Commands then by recency (or a flat result count while
 * searching); the right pane previews the highlighted session. Deliberately
 * scoped to sessions and commands only — file search lives in its own dock
 * panel.
 */
export function CommandPalette({
  open,
  onOpenChange,
  sessions,
  projectName,
  onNewChat,
  onOpenSession,
  t,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset to a clean slate whenever the palette is (re)opened.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const commands = useMemo<PaletteEntry[]>(
    () => [
      {
        kind: "command",
        id: "command:new-chat",
        label: t("newChat"),
        icon: <SquarePen className="h-4 w-4 shrink-0" />,
        run: onNewChat,
      },
    ],
    [t, onNewChat],
  );

  const { sections, flatEntries } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();

    const matchedCommands = q
      ? commands.filter((c) => matches(c.label, q))
      : commands;

    const matchedSessions: PaletteEntry[] = [];
    for (const task of sessions) {
      const title = task.title?.trim() || t("sessionUnresolved");
      const project = projectName(task.project_id);
      if (q && !matches(title, q) && !(project && matches(project, q))) {
        continue;
      }
      matchedSessions.push({
        kind: "session",
        id: `session:${task.id}`,
        label: title,
        detail: project,
        icon: <MessageSquare className="h-4 w-4 shrink-0 opacity-70" />,
        task,
        run: () => onOpenSession(task),
      });
      if (matchedSessions.length >= MAX_SESSION_RESULTS) break;
    }

    const built: PaletteSection[] = [];
    if (matchedCommands.length > 0) {
      built.push({
        id: "commands",
        heading: t("commandPaletteCommands"),
        entries: matchedCommands,
      });
    }

    if (q) {
      // While searching, a single flat results section with a count.
      if (matchedSessions.length > 0) {
        built.push({
          id: "results",
          heading: t("commandPaletteResultCount", {
            count: matchedSessions.length,
          }),
          entries: matchedSessions,
        });
      }
    } else {
      // Browsing: group sessions by recency, like the reference search.
      const buckets: Record<DateBucket, PaletteEntry[]> = {
        today: [],
        yesterday: [],
        last7: [],
        last30: [],
        older: [],
      };
      for (const entry of matchedSessions) {
        const bucket = entry.task
          ? deriveDateBucket(entry.task.updated_at, now)
          : "older";
        buckets[bucket].push(entry);
      }
      for (const bucket of BUCKET_ORDER) {
        if (buckets[bucket].length === 0) continue;
        built.push({
          id: bucket,
          heading: t(BUCKET_LABEL_KEY[bucket]),
          entries: buckets[bucket],
        });
      }
    }

    return {
      sections: built,
      flatEntries: built.flatMap((section) => section.entries),
    };
  }, [query, commands, sessions, projectName, onOpenSession, t]);

  const indexById = useMemo(
    () => new Map(flatEntries.map((entry, index) => [entry.id, index])),
    [flatEntries],
  );

  // A fresh query starts the cursor back at the top.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keep the active index in range as the result set shrinks.
  useEffect(() => {
    setActiveIndex((index) =>
      flatEntries.length === 0 ? 0 : Math.min(index, flatEntries.length - 1),
    );
  }, [flatEntries.length]);

  // Scroll the active row into view as the selection moves by keyboard.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const activeEntry = flatEntries[activeIndex] ?? null;
  const previewEntry = useDebounced(activeEntry, PREVIEW_DEBOUNCE_MS);

  const activate = useCallback(
    (index: number) => {
      const entry = flatEntries[index];
      if (!entry) return;
      close();
      entry.run();
    },
    [flatEntries, close],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // Ignore keys while an IME is composing: the Enter that commits a
      // Japanese conversion must not also activate the selection. WebKit fires
      // the commit keydown with keyCode 229 / isComposing set.
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) =>
          flatEntries.length ? (i + 1) % flatEntries.length : 0,
        );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) =>
          flatEntries.length
            ? (i - 1 + flatEntries.length) % flatEntries.length
            : 0,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        activate(activeIndex);
      }
      // Escape bubbles to the Radix dialog, which closes the palette.
    },
    [flatEntries.length, activeIndex, activate],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          className={cn(
            "fixed left-1/2 top-[10vh] z-[100] flex h-[min(600px,80vh)] w-[min(1120px,calc(100vw-2rem))] -translate-x-1/2 flex-col",
            "overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl",
            // Match the app's overlay tone: fade + subtle zoom + a gentle drop
            // from the top. `slide-*-left-1/2` cancels the -translate-x-1/2 so
            // the palette never slides horizontally — it stays centered.
            "duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            "data-[state=open]:slide-in-from-left-1/2 data-[state=closed]:slide-out-to-left-1/2",
            "data-[state=open]:slide-in-from-top-2 data-[state=closed]:slide-out-to-top-2",
          )}
        >
          <DialogTitle className="sr-only">
            {t("openCommandPalette")}
          </DialogTitle>

          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t("commandPalettePlaceholder")}
              className="h-full w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>

          <div className="flex min-h-0 flex-1">
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
              {flatEntries.length === 0 ? (
                <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                  {t("commandPaletteEmpty")}
                </div>
              ) : (
                sections.map((section) => (
                  <div key={section.id} className="mb-1">
                    <SectionHeading>{section.heading}</SectionHeading>
                    {section.entries.map((entry) => {
                      const index = indexById.get(entry.id) ?? 0;
                      return (
                        <PaletteRow
                          key={entry.id}
                          entry={entry}
                          active={index === activeIndex}
                          onHover={() => setActiveIndex(index)}
                          onSelect={() => activate(index)}
                          dataIndex={index}
                        />
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            <aside className="hidden w-[440px] shrink-0 border-l sm:block">
              <PreviewPane
                entry={previewEntry}
                projectName={projectName}
                t={t}
              />
            </aside>
          </div>

          <div className="flex h-9 shrink-0 items-center justify-between border-t px-3 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5">
                <Kbd>
                  <CornerDownLeft className="h-3 w-3" />
                </Kbd>
                {activeEntry?.kind === "command"
                  ? t("commandPaletteRunAction")
                  : t("commandPaletteOpenAction")}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="flex gap-0.5">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                </span>
                {t("commandPaletteNavigate")}
              </span>
            </div>
            <span className="flex items-center gap-1.5">
              <Kbd>esc</Kbd>
              {t("commandPaletteCloseAction")}
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

interface PaletteRowProps {
  entry: PaletteEntry;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
  dataIndex: number;
}

function PaletteRow({
  entry,
  active,
  onHover,
  onSelect,
  dataIndex,
}: PaletteRowProps) {
  return (
    <button
      type="button"
      data-index={dataIndex}
      // Pointer move (not enter) syncs the keyboard cursor to the hovered row
      // without fighting arrow-key navigation when the pointer is at rest.
      onPointerMove={onHover}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
        active ? "bg-muted text-foreground" : "text-foreground/90",
      )}
    >
      <span className="text-muted-foreground">{entry.icon}</span>
      <span className="min-w-0 flex-1 truncate">
        <span>{entry.label}</span>
        {entry.kind === "session" && entry.detail ? (
          <span className="text-muted-foreground"> · {entry.detail}</span>
        ) : null}
      </span>
    </button>
  );
}

interface PreviewPaneProps {
  entry: PaletteEntry | null;
  projectName: (projectId: string) => string | null;
  t: TranslationFunction;
}

function PreviewPane({ entry, projectName, t }: PreviewPaneProps) {
  if (!entry) {
    return <PreviewMessage>{t("commandPaletteNoSelection")}</PreviewMessage>;
  }
  if (entry.kind === "command") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <SquarePen className="h-6 w-6 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">
          {entry.label}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("commandPaletteRunHint")}
        </span>
      </div>
    );
  }
  // `task` is always present for session entries.
  return <SessionPreview task={entry.task!} projectName={projectName} t={t} />;
}

interface SessionPreviewProps {
  task: StoredTask;
  projectName: (projectId: string) => string | null;
  t: TranslationFunction;
}

function SessionPreview({ task, projectName, t }: SessionPreviewProps) {
  const query = useQuery({
    queryKey: ["task-last-message", task.id, task.updated_at],
    queryFn: () => taskApi.lastExchange(task.id),
    staleTime: 30_000,
    // Keep the prior exchange visible while moving to a new row so the panel
    // updates smoothly instead of flashing a loading state on every move.
    placeholderData: keepPreviousData,
  });

  const exchange = query.data;
  const hasContent = Boolean(exchange?.user || exchange?.assistant);
  const showLoading = query.isLoading || (query.isFetching && !hasContent);
  const project = projectName(task.project_id);
  const title = task.title?.trim() || t("sessionUnresolved");

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-5 pb-4 pt-5">
        {project ? (
          <div className="truncate text-xs text-muted-foreground">
            {project}
          </div>
        ) : null}
        <div className="mt-1 line-clamp-2 font-semibold text-foreground text-lg leading-snug">
          {title}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[12px] leading-relaxed">
        {query.isError ? (
          <PreviewMessage>{t("sessionPreviewError")}</PreviewMessage>
        ) : showLoading ? (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {t("sessionPreviewLoading")}
          </span>
        ) : hasContent ? (
          // Reset expand state when the preview switches to another session.
          <div key={task.id} className="flex flex-col gap-2">
            {exchange?.user ? (
              <div className="rounded-md bg-custom-sidebar-background-80 px-3 py-2">
                <CollapsibleMessage fadeClassName="from-custom-sidebar-background-80">
                  <UserMessageContent content={exchange.user} />
                </CollapsibleMessage>
              </div>
            ) : null}
            {exchange?.assistant ? (
              <div className="px-1">
                <Markdown>{truncate(exchange.assistant)}</Markdown>
              </div>
            ) : null}
          </div>
        ) : (
          <PreviewMessage>{t("sessionPreviewEmpty")}</PreviewMessage>
        )}
      </div>
    </div>
  );
}

function PreviewMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
