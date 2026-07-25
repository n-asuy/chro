/**
 * A pending "scroll the open diff to this file" request.
 *
 * The index of changed files lives in the right dock; the diff tab only shows
 * content. Clicking a file row therefore opens (or focuses) the diff tab and
 * leaves this request behind for the tab to consume, the same way a full-text
 * search hit drives the editor through `editorReveal`.
 *
 * `taskRunId` names the diff that should answer: a run's combined diff, or the
 * project working diff when null. The bumped `token` re-triggers the scroll
 * even when the same file is requested twice in a row.
 */
export type DiffRevealRequest = {
  path: string;
  taskRunId: string | null;
  token: number;
};

/** Drop leading slashes so vault-style paths compare equal to git paths. */
const normalize = (path: string) => path.replace(/^\/+/, "");

/**
 * Decide whether a diff panel should act on a reveal request, and on which of
 * its own paths.
 *
 * Returns null when the request targets another scope, names a file this panel
 * does not (yet) show, or has already been handled. An unresolved request stays
 * pending on purpose: a tab opened by the same click may still be waiting for
 * its diffs to stream in, and the next render resolves it.
 */
export function resolveDiffReveal({
  request,
  scopeTaskRunId,
  paths,
  handledToken,
}: {
  request: DiffRevealRequest | null;
  scopeTaskRunId: string | null | undefined;
  paths: string[];
  handledToken: number;
}): { path: string; token: number } | null {
  if (!request) return null;
  if (request.token === handledToken) return null;
  if (request.taskRunId !== (scopeTaskRunId ?? null)) return null;

  const wanted = normalize(request.path);
  if (!wanted) return null;

  const match = paths.find((path) => normalize(path) === wanted);
  if (match === undefined) return null;

  return { path: match, token: request.token };
}
