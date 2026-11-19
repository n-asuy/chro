import type { StoredTask } from "@/session/types";
import { emitTo } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import {
  SENT_SHOWN_MS,
  TALK_IDLE,
  type TalkTarget,
  cancelTalk,
  endTalk,
  hear,
  isTalking,
  talkFailed,
  talkSent,
  talkStarted,
  talkTarget,
} from "../domain/talk";
import {
  type Privacy,
  edgeLog,
  onTalk,
  onTalkError,
  openPrivacySettings,
  startCapture,
  startTalking,
  stopTalking,
} from "../lib/edge-input-client";
import { type EdgeMessage, sendEdgeMessage } from "../lib/edge-send";
import { playEdgeSound } from "../lib/edge-sounds";
import { focusEdgeWindow, subscribe } from "../lib/edge-window-client";
import { useEdgeToolbarStore } from "../state/edge-toolbar-store";

/** How long a note (permission off, send failed) stays. */
const NOTICE_SHOWN_MS = 8000;

/** Event the capture window sends the toolbar when it is done. */
export const CAPTURE_DONE_EVENT = "edge-capture-done";

/** What the capture window sends: the ask about a region, or nothing. */
export type CaptureDone =
  | { kind: "cancel" }
  | { kind: "send"; message: EdgeMessage };

/**
 * The toolbar's voice input and region capture: press to talk (the
 * microphone button, or Option held), and the camera, whose ask arrives from
 * the capture window. Both go to the target taken when they started (the
 * open card's session, else a new chat), through chro's send path, and show
 * where they went in the talk pill.
 */
export function useEdgeVoice({
  tasksById,
  newChatTitle,
  cancelCollapse,
  scheduleCollapse,
}: {
  tasksById: ReadonlyMap<string, StoredTask>;
  newChatTitle: string;
  cancelCollapse: () => void;
  scheduleCollapse: () => void;
}) {
  const talk = useEdgeToolbarStore((s) => s.talk);
  const setTalk = useEdgeToolbarStore((s) => s.setTalk);
  const tasksRef = useRef(tasksById);
  tasksRef.current = tasksById;
  const closeTimer = useRef<number | null>(null);
  // Where the open capture's ask goes (taken when the camera was clicked).
  const captureTarget = useRef<TalkTarget>({ kind: "newChat" });

  const titleOf = useCallback(
    (target: TalkTarget) =>
      target.kind === "session"
        ? tasksRef.current.get(target.taskId)?.title || newChatTitle
        : newChatTitle,
    [newChatTitle],
  );

  /** Show `state` for `ms`, then close the pill and tuck the toolbar in. */
  const showFor = useCallback(
    (ms: number) => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        setTalk(TALK_IDLE);
        scheduleCollapse();
      }, ms);
    },
    [setTalk, scheduleCollapse],
  );
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const deliver = useCallback(
    async (target: TalkTarget, message: EdgeMessage) => {
      cancelCollapse();
      setTalk(talkSent(message.text, titleOf(target)));
      showFor(SENT_SHOWN_MS);
      try {
        await sendEdgeMessage(target, message);
      } catch (error) {
        setTalk(
          talkFailed(error instanceof Error ? error.message : String(error)),
        );
        showFor(NOTICE_SHOWN_MS);
      }
    },
    [cancelCollapse, setTalk, showFor, titleOf],
  );

  const beginTalking = useCallback(async () => {
    const store = useEdgeToolbarStore.getState();
    if (isTalking(store.talk)) return;
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    cancelCollapse();
    store.startTalking(talkTarget(store.panel, store.unread.cursorId));
    // Esc reaches the window only while it has the keyboard.
    focusEdgeWindow();
    const outcome = await startTalking("toolbar");
    edgeLog(`talk start outcome=${outcome.outcome}`);
    const now = useEdgeToolbarStore.getState().talk;
    if (now.phase !== "starting") {
      // Ended while the shell was starting (a short hold, Esc).
      if (outcome.outcome === "started") void stopTalking();
      return;
    }
    const next = talkStarted(now, outcome);
    setTalk(next);
    if (next.phase === "listening") playEdgeSound("record-start");
    else if (next.phase === "notice") showFor(NOTICE_SHOWN_MS);
    else scheduleCollapse();
  }, [cancelCollapse, setTalk, showFor, scheduleCollapse]);

  // Released: the audio closes and the recognizer's final result is awaited
  // (the pill keeps showing the words meanwhile), then that is sent.
  const finishing = useRef(false);
  const finishTalking = useCallback(async () => {
    const current = useEdgeToolbarStore.getState().talk;
    if (!isTalking(current) || finishing.current) return;
    finishing.current = true;
    if (current.phase === "listening") playEdgeSound("record-stop");
    const finalText =
      current.phase === "listening"
        ? await stopTalking(true)
        : await stopTalking();
    finishing.current = false;
    const latest = useEdgeToolbarStore.getState().talk;
    const { next, send } = endTalk(latest, finalText);
    edgeLog(
      `talk end phase=${latest.phase} final=${finalText.length} partial=${
        latest.phase === "listening" ? latest.text.length : 0
      } send=${send ? send.text.length : 0}`,
    );
    setTalk(next);
    if (send) void deliver(send.target, { text: send.text });
    else scheduleCollapse();
  }, [deliver, setTalk, scheduleCollapse]);

  const cancelTalking = useCallback(() => {
    const current = useEdgeToolbarStore.getState().talk;
    const next = cancelTalk(current);
    if (next === current) return false;
    if (isTalking(current)) {
      void stopTalking();
      if (current.phase === "listening") playEdgeSound("record-stop");
    }
    setTalk(next);
    scheduleCollapse();
    return true;
  }, [setTalk, scheduleCollapse]);

  const toggleMic = useCallback(() => {
    if (isTalking(useEdgeToolbarStore.getState().talk)) finishTalking();
    else void beginTalking();
  }, [beginTalking, finishTalking]);

  const beginCapture = useCallback(async () => {
    const store = useEdgeToolbarStore.getState();
    if (isTalking(store.talk)) return;
    captureTarget.current = talkTarget(store.panel, store.unread.cursorId);
    cancelCollapse();
    store.setMoreOpen(false);
    const outcome = await startCapture();
    if (outcome.outcome === "blocked") {
      setTalk({
        phase: "notice",
        notice: { kind: "blocked", privacy: outcome.privacy },
      });
      showFor(NOTICE_SHOWN_MS);
    } else if (outcome.outcome === "unavailable") {
      setTalk({
        phase: "notice",
        notice: { kind: "unavailable", reason: outcome.reason },
      });
      showFor(NOTICE_SHOWN_MS);
    }
  }, [cancelCollapse, setTalk, showFor]);

  const openSettings = useCallback(
    (privacy: Privacy) => {
      void openPrivacySettings(privacy);
      setTalk(TALK_IDLE);
      scheduleCollapse();
    },
    [setTalk, scheduleCollapse],
  );

  // The transcript while the toolbar listens.
  useEffect(
    () =>
      onTalk((update) => {
        const store = useEdgeToolbarStore.getState();
        edgeLog(
          `talk update received owner=${update.owner} len=${update.text.length} final=${update.isFinal} phase=${store.talk.phase}`,
        );
        if (update.owner !== "toolbar") return;
        store.setTalk(hear(store.talk, update.text));
      }),
    [],
  );

  // A recognizer error ends talking with a note (nothing said: just closes).
  useEffect(
    () =>
      onTalkError((error) => {
        const current = useEdgeToolbarStore.getState().talk;
        edgeLog(
          `talk error received owner=${error.owner} noSpeech=${error.noSpeech} phase=${current.phase}: ${error.message}`,
        );
        if (
          error.owner !== "toolbar" ||
          !isTalking(current) ||
          finishing.current
        )
          return;
        void stopTalking();
        if (error.noSpeech) {
          setTalk(TALK_IDLE);
          scheduleCollapse();
          return;
        }
        setTalk({
          phase: "notice",
          notice: { kind: "unavailable", reason: error.message },
        });
        showFor(NOTICE_SHOWN_MS);
      }),
    [setTalk, scheduleCollapse, showFor],
  );

  // The capture window's ask about its region.
  useEffect(
    () =>
      subscribe<CaptureDone>(CAPTURE_DONE_EVENT, (done) => {
        if (done.kind === "send")
          void deliver(captureTarget.current, done.message);
        else scheduleCollapse();
      }),
    [deliver, scheduleCollapse],
  );

  const targetTitle =
    talk.phase === "starting" || talk.phase === "listening"
      ? talk.target.kind === "session"
        ? titleOf(talk.target)
        : null
      : null;

  return {
    talk,
    targetTitle,
    toggleMic,
    beginTalking,
    finishTalking,
    cancelTalking,
    beginCapture,
    openSettings,
  };
}

/** Tell the toolbar the capture is done (from the capture window). */
export function reportCaptureDone(done: CaptureDone): Promise<void> {
  return emitTo("edge", CAPTURE_DONE_EVENT, done);
}
