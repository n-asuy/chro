/**
 * Canonical comparison key for file-name matching: Unicode NFC normalization
 * followed by lowercasing.
 *
 * macOS (APFS/HFS+) returns decomposed (NFD) file names while text typed or
 * pasted in the webview is precomposed (NFC), so byte-equality silently fails
 * for Japanese and accented names. Every client-side name comparison goes
 * through this single function; the server mirrors it in the file-search
 * cache's `normalize_key`.
 */
export const fileNameKey = (input: string): string =>
  input.normalize("NFC").toLowerCase();

/** Whether two file names or paths refer to the same name under key rules. */
export const fileNamesEqual = (a: string, b: string): boolean =>
  fileNameKey(a) === fileNameKey(b);
