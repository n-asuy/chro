export type TextChange = { from: number; to: number; insert: string };

/**
 * The smallest single replacement turning `before` into `after`: everything
 * outside the common prefix and suffix. Dispatching this instead of a
 * whole-document replacement lets CodeMirror map the selection and keep the
 * viewport in place.
 */
export const minimalChange = (
  before: string,
  after: string,
): TextChange | null => {
  if (before === after) return null;
  const maxPrefix = Math.min(before.length, after.length);
  let prefix = 0;
  while (
    prefix < maxPrefix &&
    before.charCodeAt(prefix) === after.charCodeAt(prefix)
  ) {
    prefix += 1;
  }
  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) ===
      after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
};
