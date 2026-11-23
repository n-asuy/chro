import { invoke, isTauri } from "@tauri-apps/api/core";
import { subscribe } from "./edge-window-client";

/**
 * The renderer's side of the voice input and region capture contract with the
 * Tauri shell (`src-tauri/src/windows/edge_talk.rs`, `edge_capture.rs` and
 * `privacy.rs`). Outside Tauri nothing can listen or capture: starts report
 * the feature unavailable.
 */

/** A permission talking or capturing needs. */
export type Privacy = "microphone" | "speechRecognition" | "screenRecording";

/** Which input the words are for. */
export type TalkOwner = "toolbar" | "capture";

/** How a start went. */
export type InputStart =
  | { outcome: "started" }
  | { outcome: "blocked"; privacy: Privacy }
  | { outcome: "unavailable"; reason: string }
  | { outcome: "cancelled" };

/** The transcript so far. */
export interface TalkUpdate {
  owner: TalkOwner;
  text: string;
  isFinal: boolean;
}

/** A picked region in CSS pixels of the capture window (= screen points). */
export interface PickedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const OUTSIDE_SHELL: InputStart = {
  outcome: "unavailable",
  reason: "Talking and capturing need the desktop app.",
};

async function start(command: string, args?: object): Promise<InputStart> {
  if (!isTauri()) return OUTSIDE_SHELL;
  try {
    return await invoke<InputStart>(command, args as never);
  } catch (error) {
    return {
      outcome: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Start listening (asks for the microphone and speech recognition once). */
export function startTalking(
  owner: TalkOwner,
  /** A locale from the settings; `null` is automatic. */
  language: string | null = null,
): Promise<InputStart> {
  return start("edge_talk_start", { owner, language });
}

/** The talk languages the device recognizes, and what automatic resolves to. */
export interface TalkLanguages {
  automatic: string | null;
  locales: string[];
}

export async function fetchTalkLanguages(): Promise<TalkLanguages> {
  if (!isTauri()) return { automatic: null, locales: [] };
  return invoke<TalkLanguages>("edge_talk_languages").catch(() => ({
    automatic: null,
    locales: [],
  }));
}

/**
 * Stop listening. With `finish` (a send) the audio is closed and the
 * recognizer's final result awaited; resolves with what was heard.
 */
export async function stopTalking(finish = false): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("edge_talk_stop", { finish }).catch(() => "");
}

/** A recognizer error, worded for the person. */
export interface TalkError {
  owner: TalkOwner;
  message: string;
  /** Nothing was said: not a failure. */
  noSpeech: boolean;
}

/** Follow recognizer errors. */
export function onTalkError(handler: (error: TalkError) => void): () => void {
  return subscribe<TalkError>("edge-talk-error", handler);
}

/** A diagnostic line into the shell's log. */
export function edgeLog(message: string): void {
  if (!isTauri()) return;
  invoke("edge_log", { message }).catch(() => {});
}

/** Follow the transcript. Returns the unsubscribe function. */
export function onTalk(handler: (update: TalkUpdate) => void): () => void {
  return subscribe<TalkUpdate>("edge-talk", handler);
}

/** Open the capture window (asks for Screen Recording once). */
export function startCapture(): Promise<InputStart> {
  return start("edge_capture_start");
}

/** The PNG of a picked region, as a file to upload. */
export async function captureRegion(rect: PickedRect): Promise<File> {
  const base64 = await invoke<string>("edge_capture_region", { rect });
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new File([bytes], `capture-${stamp}.png`, { type: "image/png" });
}

/** Close the capture window. */
export async function closeCapture(): Promise<void> {
  if (!isTauri()) return;
  await invoke("edge_capture_close").catch(() => {});
}

/** Open the System Settings pane where a permission is turned on. */
export async function openPrivacySettings(privacy: Privacy): Promise<void> {
  if (!isTauri()) return;
  await invoke("edge_open_privacy_settings", { privacy }).catch(() => {});
}

/** Levels (0..1) of the microphone input, oldest first, `intervalMs` apart. */
export interface TalkLevels {
  levels: number[];
  intervalMs: number;
}

/** Follow the microphone's input level while listening. */
export function onTalkLevels(handler: (batch: TalkLevels) => void): () => void {
  return subscribe<TalkLevels>("edge-talk-level", handler);
}
