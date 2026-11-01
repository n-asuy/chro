import { useLanguage } from "@/i18n";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  BookOpen,
  Check,
  GripVertical,
  ImageIcon,
  Link2,
  Loader2,
  Pencil,
  SendHorizontal,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  moveQueueItem,
  pendingQueueOrder,
  queuedMessagePreview,
  rewriteQueuedText,
  splitQueuedMessage,
} from "../lib/session-queue";
import type { SessionQueueItem } from "../types";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

type SessionQueueListProps = {
  items: SessionQueueItem[];
  onWithdraw: (itemId: string) => void;
  /** Resolves once the server has the new text; rejects to keep editing. */
  onEdit: (itemId: string, prompt: string) => Promise<void>;
  onReorder: (itemIds: string[]) => Promise<void>;
  /** Stops the running turn and starts this message. */
  onSendNow: (itemId: string) => Promise<void>;
};

/**
 * Messages waiting in the session's queue, shown above the composer. They are
 * queued from this composer, the terminal or by agents while a turn runs, and
 * start on their own, in list order, when the session is idle. A person can
 * drag one to another place, rewrite its text, send it now (stopping the
 * running turn), or withdraw it.
 */
export function SessionQueueList({
  items,
  onWithdraw,
  onEdit,
  onReorder,
  onSendNow,
}: SessionQueueListProps) {
  const { t } = useLanguage();
  const [droppedOrder, setDroppedOrder] = useState<string[] | null>(null);
  const pending = pendingQueueOrder(items, droppedOrder);
  useEffect(() => {
    if (droppedOrder && !pending) setDroppedOrder(null);
  }, [droppedOrder, pending]);

  const ordered = useMemo(() => {
    if (!pending) return items;
    const byId = new Map(items.map((item) => [item.id, item]));
    return pending.flatMap((id) => byId.get(id) ?? []);
  }, [items, pending]);
  const ids = ordered.map((item) => item.id);

  const move = (fromId: string, toId: string) => {
    const next = moveQueueItem(ids, fromId, toId);
    if (next === ids) return;
    setDroppedOrder(next);
    onReorder(next).catch(() => setDroppedOrder(null));
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over) move(String(active.id), String(over.id));
  };

  if (ordered.length === 0) {
    return null;
  }

  return (
    <div className="-mt-1 rounded-xl border border-border/80 bg-muted/30">
      <div className="flex h-8 items-center px-3 text-xs text-muted-foreground">
        {t("queueItemsLabel", { count: ordered.length })}
      </div>
      <TooltipProvider delayDuration={120}>
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div className="max-h-48 overflow-y-auto border-t border-border/70 py-0.5">
            {ordered.map((item, index) => (
              <QueueRow
                key={item.id}
                item={item}
                index={index}
                indexOf={(id) => ids.indexOf(id)}
                onMoveBy={(offset) => {
                  const target = ids[index + offset];
                  if (target) move(item.id, target);
                }}
                onWithdraw={() => onWithdraw(item.id)}
                onEdit={(prompt) => onEdit(item.id, prompt)}
                onSendNow={() => onSendNow(item.id)}
              />
            ))}
          </div>
        </DndContext>
      </TooltipProvider>
    </div>
  );
}

function QueueRow({
  item,
  index,
  indexOf,
  onMoveBy,
  onWithdraw,
  onEdit,
  onSendNow,
}: {
  item: SessionQueueItem;
  index: number;
  indexOf: (id: string) => number;
  onMoveBy: (offset: number) => void;
  onWithdraw: () => void;
  onEdit: (prompt: string) => Promise<void>;
  onSendNow: () => Promise<void>;
}) {
  const { t } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const draggable = useDraggable({ id: item.id, disabled: editing });
  const droppable = useDroppable({ id: item.id });

  // Where the dragged row lands: above this row when it comes from below,
  // below it when it comes from above.
  const draggedFrom = droppable.active
    ? indexOf(String(droppable.active.id))
    : -1;
  const dropEdge =
    droppable.isOver && draggedFrom !== -1 && draggedFrom !== index
      ? draggedFrom > index
        ? "top"
        : "bottom"
      : null;

  const style: CSSProperties = draggable.transform
    ? {
        transform: `translate3d(0, ${draggable.transform.y}px, 0)`,
        zIndex: 10,
        position: "relative",
      }
    : {};

  const handleGripKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    onMoveBy(event.key === "ArrowUp" ? -1 : 1);
  };

  const sendNow = () => {
    setSending(true);
    onSendNow().finally(() => setSending(false));
  };

  return (
    <div
      ref={droppable.setNodeRef}
      className={cn(
        "relative",
        dropEdge === "top" &&
          "before:absolute before:inset-x-2 before:top-0 before:h-0.5 before:rounded-full before:bg-primary",
        dropEdge === "bottom" &&
          "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary",
      )}
    >
      <div
        ref={draggable.setNodeRef}
        style={style}
        data-queue-item={item.id}
        className={cn(
          "group flex items-center gap-1.5 py-1 pl-1 pr-2 text-xs",
          draggable.isDragging
            ? "rounded-md bg-background shadow-[0_1px_2px_rgba(0,0,0,.10),0_3px_8px_rgba(0,0,0,.07)]"
            : "hover:bg-muted/50",
        )}
      >
        <button
          type="button"
          ref={draggable.setActivatorNodeRef}
          {...draggable.listeners}
          {...draggable.attributes}
          onKeyDown={handleGripKeyDown}
          disabled={editing}
          aria-label={t("queueDragLabel")}
          className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 transition hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-0"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        {editing ? (
          <QueuedMessageEditor
            prompt={item.prompt}
            onCancel={() => setEditing(false)}
            onSave={(prompt) => onEdit(prompt).then(() => setEditing(false))}
          />
        ) : (
          <>
            <QueuedMessageSummary prompt={item.prompt} />
            <div className="flex shrink-0 items-center opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
              <RowAction
                label={t("queueEditLabel")}
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </RowAction>
              <RowAction
                label={t("queueSendNowLabel")}
                hint={t("queueSendNowHint")}
                onClick={sendNow}
                disabled={sending}
              >
                {sending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <SendHorizontal className="h-3.5 w-3.5" />
                )}
              </RowAction>
            </div>
            <RowAction label={t("queueRemoveAria")} onClick={onWithdraw}>
              <X className="h-3.5 w-3.5" />
            </RowAction>
          </>
        )}
      </div>
    </div>
  );
}

function RowAction({
  label,
  hint,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-default"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        {hint ? `${label}: ${hint}` : label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Rewrites the text the person wrote; images, references and skills stay. */
function QueuedMessageEditor({
  prompt,
  onSave,
  onCancel,
}: {
  prompt: string;
  onSave: (prompt: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLanguage();
  const original = splitQueuedMessage(prompt).text;
  const [text, setText] = useState(original);
  const [saving, setSaving] = useState(false);
  const { images, references, skills } = queuedMessagePreview(prompt);
  const hasAttachments = images + references + skills > 0;
  const canSave = !saving && (text.trim().length > 0 || hasAttachments);

  const save = () => {
    if (!canSave) return;
    if (text.trim() === original.trim()) {
      onCancel();
      return;
    }
    setSaving(true);
    // A failed save keeps the editor open with the text as typed.
    onSave(rewriteQueuedText(prompt, text.trim())).catch(() =>
      setSaving(false),
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The composer and pane shortcuts must not see keys typed here.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save();
    }
  };

  return (
    <>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the person just asked to edit this row
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={Math.min(6, Math.max(1, text.split("\n").length))}
        aria-label={t("queueEditLabel")}
        className="min-w-0 flex-1 resize-none rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary/60"
      />
      <RowAction
        label={t("queueEditSaveLabel")}
        onClick={save}
        disabled={!canSave}
      >
        {saving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
      </RowAction>
      <RowAction label={t("queueEditCancelLabel")} onClick={onCancel}>
        <X className="h-3.5 w-3.5" />
      </RowAction>
    </>
  );
}

function QueuedMessageSummary({ prompt }: { prompt: string }) {
  const { text, images, references, skills } = queuedMessagePreview(prompt);
  const counts = [
    { key: "images", Icon: ImageIcon, count: images },
    { key: "references", Icon: Link2, count: references },
    { key: "skills", Icon: BookOpen, count: skills },
  ].filter((entry) => entry.count > 0);
  return (
    <>
      <span className="line-clamp-1 min-w-0 flex-1 text-foreground">
        {text}
      </span>
      {counts.map(({ key, Icon, count }) => (
        <span
          key={key}
          className="flex shrink-0 items-center gap-0.5 text-muted-foreground"
        >
          <Icon className="h-3 w-3" />
          {count}
        </span>
      ))}
    </>
  );
}
