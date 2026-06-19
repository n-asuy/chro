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

export const isImageExtension = (extension?: string | null): boolean => {
  const ext = normalizeExtension(extension);
  return ext != null && IMAGE_EXTENSIONS.has(ext);
};

export const isVideoExtension = (extension?: string | null): boolean => {
  const ext = normalizeExtension(extension);
  return ext != null && VIDEO_EXTENSIONS.has(ext);
};

export const isAudioExtension = (extension?: string | null): boolean => {
  const ext = normalizeExtension(extension);
  return ext != null && AUDIO_EXTENSIONS.has(ext);
};

export const isPdfExtension = (extension?: string | null): boolean => {
  const ext = normalizeExtension(extension);
  return ext != null && PDF_EXTENSIONS.has(ext);
};

/** Classify an extension into the gallery's media kind, or null if not media. */
export const mediaKindOfExtension = (
  extension?: string | null,
): MediaKind | null => {
  if (isImageExtension(extension)) return "image";
  if (isVideoExtension(extension)) return "video";
  return null;
};

/** Whether a path/filename points at a still image, judged by its extension. */
export const isImagePath = (path?: string | null): boolean =>
  isImageExtension(extensionOf(path));
