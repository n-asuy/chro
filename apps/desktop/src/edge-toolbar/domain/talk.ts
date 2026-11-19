import type { InputStart, Privacy } from "../lib/edge-input-client";

/**
 * Press to talk (the mock's talk pill): what is heard goes to a session, the
 * one whose card is open, else a new chat. These are the pill's states and
 * the moves between them; the toolbar runs the effects (the shell, sounds,
 * the send).
 */

/** Where a voice message or a capture goes. */
export type TalkTarget =
  | { kind: "session"; taskId: string }
  | { kind: "newChat" };

/**
 * The target: the session whose compact panel is open, or the one the Unread
 * pager shows; otherwise a new chat. Never chosen from what was said.
 */
export function talkTarget(
  panel:
    | { kind: "unread" }
    | { kind: "session"; taskId: string }
    | { kind: string }
    | null,
  pagerTaskId: string | null,
): TalkTarget {
  if (panel?.kind === "session" && "taskId" in panel) {
    return { kind: "session", taskId: panel.taskId };
  }
  if (panel?.kind === "unread" && pagerTaskId) {
    return { kind: "session", taskId: pagerTaskId };
  }
  return { kind: "newChat" };
}

/** A one-line note in the pill's place, with an action when one helps. */
export type InputNotice =
  | { kind: "blocked"; privacy: Privacy }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; reason: string };

export type TalkState =
  | { phase: "idle" }
  /** Asked the shell to listen (it may be showing a permission dialog). */
  | { phase: "starting"; target: TalkTarget }
  | { phase: "listening"; text: string; target: TalkTarget }
  /** Sent; `title` names where it went. */
  | { phase: "sent"; text: string; title: string }
  | { phase: "notice"; notice: InputNotice };

export const TALK_IDLE: TalkState = { phase: "idle" };

/** How long the "sent" pill stays (the mock's talk-end). */
export const SENT_SHOWN_MS = 2200;

/** Whether the microphone is (being) turned on. */
export function isTalking(state: TalkState): boolean {
  return state.phase === "starting" || state.phase === "listening";
}

/** Start talking to `target`; ignored while already talking. */
export function beginTalk(state: TalkState, target: TalkTarget): TalkState {
  return isTalking(state) ? state : { phase: "starting", target };
}

/** The shell answered a start. */
export function talkStarted(state: TalkState, start: InputStart): TalkState {
  if (state.phase !== "starting") return state;
  switch (start.outcome) {
    case "started":
      return { phase: "listening", text: "", target: state.target };
    case "blocked":
      return {
        phase: "notice",
        notice: { kind: "blocked", privacy: start.privacy },
      };
    case "unavailable":
      return {
        phase: "notice",
        notice: { kind: "unavailable", reason: start.reason },
      };
    case "cancelled":
      return TALK_IDLE;
  }
}

/** The transcript so far (it replaces, never appends: the recognizer revises). */
export function hear(state: TalkState, text: string): TalkState {
  return state.phase === "listening" ? { ...state, text } : state;
}

/**
 * Stop talking. What was heard (the final result, else the last partial) is
 * to be sent to the target; nothing heard (or still starting) just closes
 * the pill.
 */
export function endTalk(
  state: TalkState,
  /** The recognizer's final result, when it gave one. */
  finalText = "",
): {
  next: TalkState;
  send: { text: string; target: TalkTarget } | null;
} {
  if (state.phase === "starting") return { next: TALK_IDLE, send: null };
  if (state.phase !== "listening") return { next: state, send: null };
  const text = finalText.trim() || state.text.trim();
  if (!text) return { next: TALK_IDLE, send: null };
  return { next: TALK_IDLE, send: { text, target: state.target } };
}

/** Esc: stop without sending. */
export function cancelTalk(state: TalkState): TalkState {
  return isTalking(state) || state.phase === "notice" ? TALK_IDLE : state;
}

/** A message (voice or capture) reached `title`. */
export function talkSent(text: string, title: string): TalkState {
  return { phase: "sent", text, title };
}

/** A send failed. */
export function talkFailed(reason: string): TalkState {
  return { phase: "notice", notice: { kind: "failed", reason } };
}

/**
 * The words of a transcript to show: the part that was already shown stays,
 * the rest fades in. Recognizers revise their guess, and scripts like
 * Japanese have no spaces, so the split is by the longest common prefix of
 * characters rather than by words.
 */
export function transcriptSegments(
  shown: string,
  next: string,
): { kept: string; added: string } {
  let common = 0;
  const limit = Math.min(shown.length, next.length);
  while (common < limit && shown[common] === next[common]) common++;
  return { kept: next.slice(0, common), added: next.slice(common) };
}

/** What an Option gesture does to the toolbar. */
export type OptionAction = "summon" | "startTalk" | "endTalk" | "none";

export function optionAction(
  gesture: "summon" | "holdStart" | "holdEnd" | "send",
  state: TalkState,
): OptionAction {
  switch (gesture) {
    case "summon":
      return isTalking(state) ? "endTalk" : "summon";
    case "holdStart":
      return isTalking(state) ? "none" : "startTalk";
    case "holdEnd":
    case "send":
      return isTalking(state) ? "endTalk" : "none";
  }
}

/** A run of transcript text shown with one fade-in. */
export interface TranscriptChunk {
  key: number;
  text: string;
}

/**
 * The chunks to show for a new transcript: chunks still matching stay (cut
 * where a revision changed them), and the new text is one more chunk that
 * fades in.
 */
export function nextChunks(
  chunks: readonly TranscriptChunk[],
  text: string,
): TranscriptChunk[] {
  const shown = chunks.map((chunk) => chunk.text).join("");
  const { kept, added } = transcriptSegments(shown, text);
  const out: TranscriptChunk[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (used >= kept.length) break;
    const piece = chunk.text.slice(0, kept.length - used);
    out.push(piece === chunk.text ? chunk : { key: chunk.key, text: piece });
    used += piece.length;
  }
  if (added) {
    const key = chunks.reduce((max, chunk) => Math.max(max, chunk.key), -1) + 1;
    out.push({ key, text: added });
  }
  return out;
}
