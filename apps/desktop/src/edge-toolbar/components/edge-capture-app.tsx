import "../edge-toolbar.css";
import { useLanguage } from "@/i18n";
import { uploadImage } from "@/lib/image-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CAPTURE_START,
  type CaptureState,
  askPlacement,
  drag,
  finishPick,
  rectBetween,
  sendAsk,
  sendFailed,
  setAsk,
} from "../domain/capture";
import { reportCaptureDone } from "../hooks/use-edge-voice";
import {
  type PickedRect,
  captureRegion,
  closeCapture,
  onTalk,
  startTalking,
  stopTalking,
} from "../lib/edge-input-client";
import { playEdgeSound } from "../lib/edge-sounds";
import { onOptionGesture } from "../lib/edge-window-client";
import { ArrowUpGlyph, MicGlyph } from "./edge-glyphs";

/** How long the ask pill blurs away on send (the mock's leave). */
const LEAVE_MS = 100;

/**
 * Point at it (the mock's region picker), in a transparent window over the
 * whole screen under the pointer: the screen dims and a tip says to drag;
 * the dragged region is screenshotted (without this window or the toolbar),
 * then the ask pill under it takes what should happen with it, typed or
 * said. The ask and the screenshot go to the toolbar, which sends them.
 */
export function EdgeCaptureApp() {
  const { t } = useLanguage();
  const [state, setState] = useState<CaptureState>(CAPTURE_START);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dictating, setDictating] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const start = useRef<{ x: number; y: number } | null>(null);
  const shot = useRef<Promise<File> | null>(null);
  // The text before dictation began; what is said is added after it.
  const dictationBase = useRef("");
  const input = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    document.documentElement.dataset.capture = "";
    return () => {
      delete document.documentElement.dataset.capture;
    };
  }, []);

  const cancel = useCallback(() => {
    void stopTalking();
    void reportCaptureDone({ kind: "cancel" }).catch(() => {});
    void closeCapture();
  }, []);

  // Stop dictating; with `finish`, the recognizer's final result goes into
  // the field. Resolves with the field's new text (null when unchanged).
  const stopDictating = useCallback(async (finish = true) => {
    setDictating(false);
    const finalText = await stopTalking(finish);
    if (!finish || !finalText) return null;
    const base = dictationBase.current;
    const text = base ? `${base} ${finalText}` : finalText;
    const next = setAsk(stateRef.current, text);
    stateRef.current = next;
    setState(next);
    return text;
  }, []);

  const send = useCallback(async () => {
    const sending = sendAsk(stateRef.current);
    if (!sending || sending.phase !== "sending") return;
    void stopTalking();
    setState(sending);
    setError(null);
    try {
      const file = await (shot.current ?? captureRegion(sending.rect));
      const image = await uploadImage(file);
      setLeaving(true);
      await new Promise((resolve) => window.setTimeout(resolve, LEAVE_MS));
      await reportCaptureDone({
        kind: "send",
        message: {
          text: sending.text,
          image: {
            id: image.id,
            file_path: image.file_path,
            original_name: image.original_name,
          },
        },
      });
      await closeCapture();
    } catch (cause) {
      setLeaving(false);
      setState((current) => sendFailed(current));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const startDictating = useCallback(async () => {
    if (stateRef.current.phase !== "asking") return;
    dictationBase.current = stateRef.current.text;
    setDictating(true);
    const outcome = await startTalking("capture");
    if (outcome.outcome !== "started") {
      setDictating(false);
      if (outcome.outcome === "blocked" || outcome.outcome === "unavailable") {
        setError(
          outcome.outcome === "unavailable"
            ? outcome.reason
            : t("edgeToolbarPrivacyOff", {
                permission: t("edgeToolbarPrivacyMicrophone"),
              }),
        );
      }
    }
  }, [t]);

  // What is said goes into the ask field.
  useEffect(
    () =>
      onTalk((update) => {
        if (update.owner !== "capture") return;
        const base = dictationBase.current;
        const text =
          base && update.text ? `${base} ${update.text}` : base || update.text;
        setState((current) => setAsk(current, text));
      }),
    [],
  );

  // Option held talks into the field and sends on release; tapped while
  // talking, it sends.
  useEffect(
    () =>
      onOptionGesture((gesture) => {
        if (gesture === "holdStart") void startDictating();
        if (gesture === "holdEnd" || gesture === "send") {
          void stopDictating().then(() => send());
        }
      }),
    [startDictating, stopDictating, send],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (dictating) void stopDictating(false);
      else cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dictating, stopDictating, cancel]);

  const asking = state.phase !== "picking";
  useEffect(() => {
    if (asking) requestAnimationFrame(() => input.current?.focus());
  }, [asking]);

  const point = (event: React.PointerEvent) => ({
    x: event.clientX,
    y: event.clientY,
  });
  const dragging = state.phase === "picking" ? state.dragging : null;
  const rect: PickedRect | null =
    state.phase === "picking" ? dragging : state.rect;
  const place = rect
    ? askPlacement(rect, {
        width: window.innerWidth,
        height: window.innerHeight,
      })
    : null;
  const text = state.phase === "picking" ? "" : state.text;

  return (
    <div className="edge-root edge-capture">
      <div
        className="edge-capture-layer"
        data-asking={asking ? "" : undefined}
        onPointerDown={(event) => {
          if (stateRef.current.phase !== "picking") return;
          start.current = point(event);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!start.current) return;
          setState((current) =>
            drag(
              current,
              rectBetween(start.current ?? point(event), point(event)),
            ),
          );
        }}
        onPointerUp={(event) => {
          if (!start.current) return;
          const picked = rectBetween(start.current, point(event));
          start.current = null;
          const next = finishPick(stateRef.current, picked);
          if (next === "cancel") {
            cancel();
            return;
          }
          playEdgeSound("confirm");
          // The screen as it is now, not when the ask is sent.
          shot.current = captureRegion(picked);
          shot.current.catch(() => {});
          setState(next);
        }}
      >
        <div className="edge-capture-shade" />
        <div className="edge-capture-help">{t("edgeCaptureHelp")}</div>
        {rect ? (
          <div
            className="edge-capture-rect"
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
            }}
          >
            <span className="edge-capture-size">
              {Math.round(rect.width)} × {Math.round(rect.height)}
            </span>
          </div>
        ) : null}
      </div>
      <div
        className="edge-ask"
        data-on={asking ? "" : undefined}
        data-leaving={leaving ? "" : undefined}
        style={place ? { left: place.left, top: place.top } : undefined}
      >
        <div className="edge-ask-row">
          <div className="edge-ask-field">
            <textarea
              ref={input}
              rows={1}
              spellCheck={false}
              value={text}
              placeholder={t("edgeCaptureAsk")}
              onChange={(event) =>
                setState((current) => setAsk(current, event.target.value))
              }
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <button
              type="button"
              title={t("edgeCaptureDictate")}
              aria-label={t("edgeCaptureDictate")}
              aria-pressed={dictating}
              data-recording={dictating ? "" : undefined}
              onClick={() =>
                void (dictating ? stopDictating() : startDictating())
              }
              className="edge-ask-mic"
            >
              <MicGlyph />
            </button>
          </div>
          <button
            type="button"
            title={t("edgeCaptureSend")}
            aria-label={t("edgeCaptureSend")}
            data-on={text.trim() ? "" : undefined}
            onClick={() => void send()}
            className="edge-ask-send"
          >
            <ArrowUpGlyph />
          </button>
        </div>
        <div className="edge-ask-hint">{error ?? t("edgeCaptureHint")}</div>
      </div>
    </div>
  );
}
