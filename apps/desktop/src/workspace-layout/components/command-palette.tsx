import type { TranslationFunction, TranslationKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { CollapsibleMessage } from "@/session/components/collapsible-message";
import { Markdown } from "@/session/components/markdown";
import { SessionActivityIndicator } from "@/session/components/session-activity-indicator";
import { SessionLeadingMarker } from "@/session/components/session-leading-marker";
import { UserMessageContent } from "@/session/conversation-view";
import { useTaskStatusDot } from "@/session/hooks";
import { formatRelativeTime } from "@/session/lib/relative-time";
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
  Folder,
  Loader2,
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
import {
  type PaletteSectionId,
  buildPaletteSections,
} from "../domain/palette-navigation";

const SECTION_LABEL_KEY: Record<PaletteSectionId, TranslationKey> = {
  commands: "commandPaletteCommands",
  attention: "commandPaletteAttention",
  recent: "commandPaletteRecent",
  projects: "commandPaletteProjects",
  sessions: "commandPaletteSessions",
};

/** Cap the previewed reply so an enormous message doesn't render in full. */
const PREVIEW_MAX_CHARS = 2000;
/** Settle time before the preview pane follows the selection, so fast
 * arrow-key scrolling doesn't fire a fetch for every row it passes through. */
const PREVIEW_DEBOUNCE_MS = 120;

const truncate = (text: string): string =>
  text.length > PREVIEW_MAX_CHARS
    ? `${text.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`
    : text;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/** A single actionable row: a command, a session, or a project destination. */
interface PaletteEntry {
  kind: "command" | "session" | "project";
  id: string;
  label: string;
  /** Secondary text (the session's project name). */
  detail?: string | null;
  /** Leading glyph for command/project rows; session rows derive their own. */
  icon?: ReactNode;
  /** Present for session rows, which reuse the sidebar's row language. */
  task?: StoredTask;
  run: () => void;
}

/** A labelled run of entries in the list. */
interface PaletteSectionView {
  id: PaletteSectionId;
  heading: string;
  entries: PaletteEntry[];
}

export interface PaletteProjectDestination {
  id: string;
  name: string;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Searchable sessions, already ordered most-recent-first. */
  sessions: StoredTask[];
  /** Project destinations (the hidden General project excluded). */
  projects: PaletteProjectDestination[];
  /** Resolves a task's `project_id` to a display name. */
  projectName: (projectId: string) => string | null;
  /** Read watermark per task; feeds the unseen-failure marker. */
  lastViewedAt: (taskId: string) => string | null | undefined;
  onNewChat: () => void;
  onOpenSession: (task: StoredTask) => void;
  onOpenProject: (projectId: string) => void;
  t: TranslationFunction;
}

/**
 * Quick-switcher palette (⌘K / ⌘P): a single-column "where do you want to
 * go?" modal. With no query it lists likely destinations — commands, sessions
 * that need the user (blocked on input, unseen failures), then recent
 * sessions; typing turns it into a ranked search over commands, projects and
 * sessions. Navigation only, no preview — file/content search lives in its
 * own dock panel.
 */
export function CommandPalette({
  open,
  onOpenChange,
  sessions,
  projects,
  projectName,
  lastViewedAt,
  onNewChat,
  onOpenSession,
  onOpenProject,
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

  const { sections, flatEntries } = useMemo(() => {
    const projectsById = new Map(
      projects.map((project) => [project.id, project]),
    );
    const commandEntries = new Map<string, PaletteEntry>([
      [
        "new-chat",
        {
          kind: "command",
          id: "command:new-chat",
          label: t("newChat"),
          icon: <SquarePen className="h-4 w-4 shrink-0" />,
          run: onNewChat,
        },
      ],
    ]);
    const built = buildPaletteSections({
      query,
      commands: [...commandEntries].map(([id, entry]) => ({
        id,
        label: entry.label,
      })),
      sessions,
      projects,
      projectNameOf: projectName,
      lastViewedAtOf: lastViewedAt,
    });

    const views: PaletteSectionView[] = built.map((section) => ({
      id: section.id,
      heading: t(SECTION_LABEL_KEY[section.id]),
      entries: section.items.flatMap((item): PaletteEntry[] => {
        if (item.kind === "command") {
          const entry = commandEntries.get(item.commandId);
          return entry ? [entry] : [];
        }
        if (item.kind === "project") {
          const project = projectsById.get(item.projectId);
          return [
            {
              kind: "project",
              id: `project:${item.projectId}`,
              label: project?.name ?? item.projectId,
              icon: <Folder className="h-4 w-4 shrink-0 opacity-70" />,
              run: () => onOpenProject(item.projectId),
            },
          ];
        }
        const task = item.task;
        return [
          {
            kind: "session",
            id: `session:${task.id}`,
            label: task.title?.trim() || t("sessionUnresolved"),
            detail: projectName(task.project_id),
            task,
            run: () => onOpenSession(task),
          },
        ];
      }),
    }));

    return {
      sections: views,
      flatEntries: views.flatMap((section) => section.entries),
    };
  }, [
    query,
    sessions,
    projects,
    projectName,
    lastViewedAt,
    onNewChat,
    onOpenSession,
    onOpenProject,
    t,
  ]);

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
  // The pane follows the active row — pointer hover syncs the active index via
  // onPointerMove, so hovering previews too. Debounced so fast arrow-key
  // travel doesn't fetch every row it passes.
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
            "fixed left-1/2 top-[10vh] z-[100] flex h-[min(560px,75vh)] w-[min(1040px,calc(100vw-2rem))] -translate-x-1/2 flex-col",
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
                          t={t}
                        />
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Right half: preview of the highlighted row (hover or arrows). */}
            <aside className="hidden w-[480px] shrink-0 border-l sm:block">
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

/**
 * Session-row body borrowed from the left panel's language: the same leading
 * status marker (hollow bullet / unread blue dot / amber failure triangle /
 * struck-through cleaned bullet), the running spinner or awaiting-input pause
 * on the right, and the compact relative timestamp otherwise.
 */
function SessionRowContent({
  task,
  label,
  detail,
  t,
}: {
  task: StoredTask;
  label: string;
  detail?: string | null;
  t: TranslationFunction;
}) {
  const dotKind = useTaskStatusDot(task);
  const isRunning = Boolean(task.active_session_id);
  return (
    <>
      <span className="flex w-4 shrink-0 items-center justify-center">
        <SessionLeadingMarker kind={dotKind} t={t} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span>{label}</span>
        {detail ? (
          <span className="text-muted-foreground"> · {detail}</span>
        ) : null}
      </span>
      {isRunning ? (
        <SessionActivityIndicator
          awaitingInput={Boolean(task.awaiting_input)}
          t={t}
        />
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatRelativeTime(task.updated_at)}
        </span>
      )}
    </>
  );
}

interface PaletteRowProps {
  entry: PaletteEntry;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
  dataIndex: number;
  t: TranslationFunction;
}

const rowClassName = (active: boolean): string =>
  cn(
    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
    active ? "bg-muted text-foreground" : "text-foreground/90",
  );

function PaletteRow(props: PaletteRowProps) {
  return props.entry.task ? (
    <SessionPaletteRow {...props} task={props.entry.task} />
  ) : (
    <PlainPaletteRow {...props} />
  );
}

function PlainPaletteRow({
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
      className={rowClassName(active)}
    >
      <span className="text-muted-foreground">{entry.icon}</span>
      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
    </button>
  );
}

/**
 * Session row: split from {@link PlainPaletteRow} because it calls hooks per
 * task. Hovering it (via the shared onPointerMove cursor sync) makes it the
 * active row, which the preview pane follows.
 */
function SessionPaletteRow({
  entry,
  task,
  active,
  onHover,
  onSelect,
  dataIndex,
  t,
}: PaletteRowProps & { task: StoredTask }) {
  return (
    <button
      type="button"
      data-index={dataIndex}
      // Pointer move (not enter) syncs the keyboard cursor to the hovered row
      // without fighting arrow-key navigation when the pointer is at rest.
      onPointerMove={onHover}
      onClick={onSelect}
      className={rowClassName(active)}
    >
      <SessionRowContent
        task={task}
        label={entry.label}
        detail={entry.detail}
        t={t}
      />
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
  if (entry.kind === "command" || entry.kind === "project") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        {entry.kind === "command" ? (
          <SquarePen className="h-6 w-6 text-muted-foreground" />
        ) : (
          <Folder className="h-6 w-6 text-muted-foreground" />
        )}
        <span className="text-sm font-medium text-foreground">
          {entry.label}
        </span>
        <span className="text-xs text-muted-foreground">
          {entry.kind === "command"
            ? t("commandPaletteRunHint")
            : t("commandPaletteOpenHint")}
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
