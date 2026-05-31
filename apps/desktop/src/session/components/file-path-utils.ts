const LINE_COL_SUFFIX = /:\d+(?::\d+)?$/;
const URL_PROTOCOL = /^[a-z][a-z0-9+.-]*:\/\//i;
const FILE_EXTENSION_TAIL = /\.[A-Za-z0-9]{1,12}(?::\d+(?::\d+)?)?$/;

export const stripLineColumnSuffix = (path: string): string =>
  path.replace(LINE_COL_SUFFIX, "");

export const looksLikeFilePath = (text: string): boolean => {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return false;
  if (/[\s`'"<>]/.test(trimmed)) return false;
  if (URL_PROTOCOL.test(trimmed)) return false;
  if (trimmed.startsWith("#")) return false;
  if (trimmed === "/" || trimmed === "//") return false;

  if (trimmed.includes("/")) {
    return /[A-Za-z0-9._\-/]/.test(trimmed);
  }

  return FILE_EXTENSION_TAIL.test(trimmed);
};
