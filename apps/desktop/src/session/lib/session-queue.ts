import type { SessionQueueItem } from "../types";
import { parseContextFromContent } from "../types/context";

/** The session's waiting messages in the order they become turns: queue
 * order, then arrival. */
export function orderSessionQueue(
  queue: Record<string, SessionQueueItem>,
  taskId: string | null,
): SessionQueueItem[] {
  if (!taskId) return [];
  return Object.values(queue)
    .filter((item) => item.task_id === taskId)
    .sort((a, b) => a.seq - b.seq || a.created_at.localeCompare(b.created_at));
}

/**
 * A just-dropped order, shown at once while the server applies it. It holds
 * only while the stream still shows the same messages in another order;
 * `null` once the stream confirms it or the queue changed under it, so the
 * stream is the truth again.
 */
export function pendingQueueOrder(
  items: SessionQueueItem[],
  order: string[] | null,
): string[] | null {
  if (!order || order.length !== items.length) return null;
  const streamed = items.map((item) => item.id);
  if (streamed.every((id, index) => id === order[index])) return null;
  const waiting = new Set(streamed);
  return order.every((id) => waiting.has(id)) ? order : null;
}

/** The queue order after dropping `fromId` onto `toId`'s place. Returns `ids`
 * itself when nothing moves. */
export function moveQueueItem(
  ids: string[],
  fromId: string,
  toId: string,
): string[] {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from === -1 || to === -1 || from === to) return ids;
  const next = ids.filter((id) => id !== fromId);
  next.splice(to, 0, fromId);
  return next;
}

/**
 * What the composer does with a message. A session takes one turn at a time,
 * so a message written while a turn runs, or while earlier messages still
 * wait, joins the queue instead of starting a turn. A new session has no
 * queue until its first turn creates it, so the composer holds until then.
 */
export function composerSubmitIntent({
  taskId,
  turnInFlight,
  waiting,
}: {
  taskId: string | null;
  turnInFlight: boolean;
  waiting: number;
}): "send" | "queue" | "hold" {
  if (!turnInFlight && waiting === 0) return "send";
  return taskId ? "queue" : "hold";
}

/** A queued message as its list row shows it: the text the person wrote, and
 * how many images, references and skills travel with it. */
export function queuedMessagePreview(prompt: string): {
  text: string;
  images: number;
  references: number;
  skills: number;
} {
  const parsed = parseContextFromContent(prompt);
  return {
    text: parsed.text.trim(),
    images: parsed.imageEntries.length,
    references: parsed.contextEntries.length,
    skills: parsed.skillEntries.length,
  };
}

/**
 * A queued message split into the markup the composer put in front (context,
 * skills, images) and the text the person wrote, which is what an edit
 * changes. When markup sits inside the text (a message written elsewhere),
 * the whole message is the text.
 */
export function splitQueuedMessage(prompt: string): {
  prefix: string;
  text: string;
} {
  const { text } = parseContextFromContent(prompt);
  if (!text) return { prefix: prompt, text: "" };
  if (prompt.endsWith(text)) {
    return { prefix: prompt.slice(0, prompt.length - text.length), text };
  }
  return { prefix: "", text: prompt };
}

/** The queued message with its written text replaced; attachments stay. */
export function rewriteQueuedText(prompt: string, text: string): string {
  const { prefix } = splitQueuedMessage(prompt);
  if (!prefix || prefix.endsWith("\n")) return `${prefix}${text}`;
  return `${prefix}\n${text}`;
}
