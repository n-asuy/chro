/**
 * Resolution of image/embed references found inside a document.
 *
 * A reference is meaningless without knowing which space the document lives
 * in. A document addressed workspace-relatively ("docs/note.md") resolves its
 * references against the workspace root, where a leading slash keeps its
 * root-relative markdown meaning. A document addressed by a host-absolute path
 * ("/Users/alice/vault/docs/note.md") resolves its references in that same
 * absolute space, so the leading slash must survive: the file endpoints serve
 * absolute paths directly, but only while the path still looks absolute.
 *
 * Absolute-ness is therefore inherited from the document rather than guessed
 * per reference, which is what keeps a plain `![](img.png)` working in a
 * document opened from outside the current workspace root.
 */

const directoryOf = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
};

/** Collapse "." and ".." segments, dropping empties. */
const normalizeSegments = (path: string): string[] => {
  const resolved: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") {
      resolved.pop();
    } else if (segment !== "." && segment !== "") {
      resolved.push(segment);
    }
  }
  return resolved;
};

/**
 * Resolve `reference` as written inside the document at `documentPath`.
 *
 * Returns a host-absolute path when the document itself is host-absolute, and
 * a workspace-relative path otherwise.
 */
export const resolveEmbedPath = (
  documentPath: string | null | undefined,
  reference: string,
): string => {
  const isAbsoluteSpace = documentPath?.startsWith("/") ?? false;

  let joined: string;
  if (reference.startsWith("/")) {
    // In absolute space this is already a host path; in relative space it
    // carries the root-relative markdown meaning, and normalization below
    // drops the leading slash accordingly.
    joined = reference;
  } else {
    const directory = documentPath ? directoryOf(documentPath) : "";
    joined = directory ? `${directory}/${reference}` : reference;
  }

  const normalized = normalizeSegments(joined).join("/");
  return isAbsoluteSpace ? `/${normalized}` : normalized;
};
