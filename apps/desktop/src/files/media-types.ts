/**
 * Single source of truth for which file extensions the app treats as
 * renderable media. These sets were previously duplicated (and had drifted on
 * ico/tiff/audio) across the file editor, the diff viewer, and the prose embed
 * plugin; they now all import from here. Mirrored on the Rust side by
 * `classify_media` in `crates/filesystem/src/workspace.rs`.
 */

export const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
  "ico",
  "tiff",
  "tif",
]);

export const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "mov",
  "avi",
  "mkv",
  "m4v",
]);

export const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "flac",
  "aac",
]);

export const PDF_EXTENSIONS = new Set(["pdf"]);

export type MediaKind = "image" | "video";

const normalizeExtension = (extension?: string | null): string | null => {
  if (!extension) return null;
  const trimmed = extension.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/^\./, "");
};

/** Extract the lowercase extension (no leading dot) from a path or filename. */
export const extensionOf = (path?: string | null): string | null => {
  if (!path) return null;
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  // `dot <= 0` rejects both "no extension" and dotfiles like ".env".
  if (dot <= 0) return null;
  return name.slice(dot + 1).toLowerCase();
};

/** The dedicated viewer a file opens in instead of the text editor. */
export type MediaViewer = "image" | "video" | "audio" | "pdf";

const MEDIA_VIEWERS: ReadonlyArray<[MediaViewer, Set<string>]> = [
  ["image", IMAGE_EXTENSIONS],
  ["video", VIDEO_EXTENSIONS],
  ["audio", AUDIO_EXTENSIONS],
  ["pdf", PDF_EXTENSIONS],
];

/** The viewer for an extension, or `null` when the file is edited as text. */
export const mediaViewerFor = (
  extension?: string | null,
): MediaViewer | null => {
  const ext = normalizeExtension(extension);
  if (ext == null) return null;
  return (
    MEDIA_VIEWERS.find(([, extensions]) => extensions.has(ext))?.[0] ?? null
  );
};

/** Whether a path/filename points at a still image, judged by its extension. */
export const isImagePath = (path?: string | null): boolean =>
  mediaViewerFor(extensionOf(path)) === "image";

/** Extensions edited as prose (the live-preview markdown editor). */
export const PROSE_EXTENSIONS = new Set(["md", "mdx", "txt"]);

// Prose is a strict whitelist. Extensionless files (LICENSE, Makefile) and
// dotfiles (.env, .gitignore) are code.
export const isProseExtension = (extension?: string | null): boolean => {
  const ext = normalizeExtension(extension);
  return ext != null && PROSE_EXTENSIONS.has(ext);
};

export const isProsePath = (path?: string | null): boolean =>
  isProseExtension(extensionOf(path));
