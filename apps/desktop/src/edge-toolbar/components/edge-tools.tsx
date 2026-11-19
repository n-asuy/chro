import { useLanguage } from "@/i18n";
import { CameraGlyph, MicGlyph } from "./edge-glyphs";
import { EdgeLevelBars } from "./edge-level-bars";

/**
 * The tools capsule (the mock's `.tools`, without its router): the
 * microphone, which turns into a live level meter while listening, and the camera,
 * which starts picking a region of the screen.
 */
export function EdgeTools({
  collapsed,
  recording,
  onMic,
  onCapture,
}: {
  collapsed: boolean;
  recording: boolean;
  onMic: () => void;
  onCapture: () => void;
}) {
  const { t } = useLanguage();
  const micLabel = recording
    ? t("edgeToolbarStopRecording")
    : t("edgeToolbarStartRecording");
  return (
    <div
      className="edge-chrome edge-tools"
      aria-hidden={collapsed || undefined}
    >
      <button
        type="button"
        data-edge-mic
        data-edge-hover={collapsed ? undefined : "mic"}
        data-recording={recording ? "" : undefined}
        title={micLabel}
        aria-label={micLabel}
        aria-pressed={recording}
        tabIndex={collapsed ? -1 : undefined}
        onClick={onMic}
        className="edge-tool"
      >
        <MicGlyph />
        {recording ? <EdgeLevelBars /> : null}
      </button>
      <button
        type="button"
        data-edge-hover={collapsed ? undefined : "camera"}
        title={t("edgeToolbarCapture")}
        aria-label={t("edgeToolbarCapture")}
        tabIndex={collapsed ? -1 : undefined}
        onClick={onCapture}
        className="edge-tool"
      >
        <CameraGlyph />
      </button>
    </div>
  );
}
