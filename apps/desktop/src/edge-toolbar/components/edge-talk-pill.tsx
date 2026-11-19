import { type TranslationKey, useLanguage } from "@/i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type InputNotice,
  type TalkState,
  type TranscriptChunk,
  nextChunks,
} from "../domain/talk";
import type { Privacy } from "../lib/edge-input-client";
import { CheckGlyph } from "./edge-glyphs";

const PRIVACY_LABEL: Record<Privacy, TranslationKey> = {
  microphone: "edgeToolbarPrivacyMicrophone",
  speechRecognition: "edgeToolbarPrivacySpeech",
  screenRecording: "edgeToolbarPrivacyScreen",
};

function noticeText(
  notice: InputNotice,
  t: ReturnType<typeof useLanguage>["t"],
): string {
  switch (notice.kind) {
    case "blocked":
      return t("edgeToolbarPrivacyOff", {
        permission: t(PRIVACY_LABEL[notice.privacy]),
      });
    case "unavailable":
      return notice.reason;
    case "failed":
      return t("edgeToolbarSendFailed", { reason: notice.reason });
  }
}

/** The transcript, the part already shown kept and new words fading in. */
function useTranscriptChunks(text: string | null): TranscriptChunk[] {
  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  useEffect(() => {
    setChunks((current) => nextChunks(current, text ?? ""));
  }, [text]);
  return chunks;
}

/**
 * Press to talk (the mock's talk pill): beside the microphone, it opens as a
 * circle at the toolbar and grows toward the screen while listening, words
 * fading in as they are heard; then it shows where the message went. A
 * permission that is off, or a system that cannot listen, is a one-line note
 * in its place, with a button to the System Settings pane when one helps.
 */
export function EdgeTalkPill({
  talk,
  targetTitle,
  onOpenSettings,
}: {
  talk: TalkState;
  /** The session the words go to; none for a new chat. */
  targetTitle: string | null;
  onOpenSettings: (privacy: Privacy) => void;
}) {
  const { t } = useLanguage();
  const listening = talk.phase === "starting" || talk.phase === "listening";
  const chunks = useTranscriptChunks(
    talk.phase === "listening" ? talk.text : listening ? "" : null,
  );
  const notice = talk.phase === "notice" ? talk.notice : null;
  // A transcript longer than the pill shows its newest words.
  const textRef = useRef<HTMLSpanElement | null>(null);
  // Pinned again as the pill grows open (its width animates).
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text || chunks.length === 0) return;
    const pin = () => {
      text.scrollLeft = text.scrollWidth;
    };
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(text);
    return () => observer.disconnect();
  }, [chunks]);
  const phase = listening ? "listening" : talk.phase;

  return (
    <div
      className="edge-talk"
      data-phase={phase}
      data-on={talk.phase === "idle" ? undefined : ""}
      data-edge-hit={notice?.kind === "blocked" ? "" : undefined}
      aria-live="polite"
    >
      {listening ? (
        <span ref={textRef} className="edge-talk-text">
          {targetTitle ? (
            <span className="edge-talk-to">
              {t("edgeToolbarTalkTo", { title: targetTitle })}{" "}
            </span>
          ) : null}
          {chunks.map((chunk) => (
            <span key={chunk.key} className="edge-talk-word">
              {chunk.text}
            </span>
          ))}
        </span>
      ) : null}
      {talk.phase === "sent" ? (
        <>
          <span className="edge-talk-sent">
            <CheckGlyph />
            <span className="edge-talk-sent-line">
              <span>{t("edgeToolbarSentTo")}&nbsp;</span>
              <b>{talk.title}</b>
              <span>&nbsp;· {t("edgeToolbarThisMac")}</span>
            </span>
          </span>
          <span className="edge-talk-live" />
        </>
      ) : null}
      {notice ? (
        <span className="edge-talk-notice">
          <span className="edge-talk-notice-text">{noticeText(notice, t)}</span>
          {notice.kind === "blocked" ? (
            <button
              type="button"
              onClick={() => onOpenSettings(notice.privacy)}
              className="edge-talk-settings"
            >
              {t("edgeToolbarOpenSettings")}
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
