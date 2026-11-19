import { useFilesStore } from "@/files/state/files-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  type PathLinkScope,
  type PathLinkTarget,
  resolvePathLink,
} from "./path-link";

/**
 * The scope every path-like reference below this point resolves against.
 *
 * Provided by the surface that knows it (a session provides its run, a project
 * view provides its project) and consumed through context rather than threaded
 * as a prop: the references live in deeply nested, memoized message renderers,
 * and the scope is a property of the surface, not of any one message.
 */
const PathLinkScopeContext = createContext<PathLinkScope>({});

export const PathLinkScopeProvider = PathLinkScopeContext.Provider;

export const usePathLinkScope = (): PathLinkScope =>
  useContext(PathLinkScopeContext);

/**
 * How long a reference must hold still before it is worth resolving. A message
 * streams in token by token, so `~/notes/report.html` passes through a dozen
 * prefixes that name nothing; waiting for the text to settle spends one probe
 * on the final reference instead of one on each prefix.
 */
const SETTLE_MS = 150;

/** Backoff after a probe that could not be made (server busy or restarting). */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

const retryDelay = (failures: number): number =>
  Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);

type Resolution = { key: string; target: PathLinkTarget | null };

/**
 * Resolve `text` to an existing file or directory.
 *
 * Returns `undefined` while the answer is not known yet, and `null` once the
 * text is known not to name anything (or there is no text). Renderers that
 * only decorate text as a link can treat both alike; renderers whose content
 * *is* the file, such as an image, show the first as loading and only the
 * second as missing.
 *
 * A probe that fails is not an answer: it is retried with backoff rather than
 * leaving the reference unresolved for as long as it stays on screen.
 */
export const usePathLink = (
  text: string | null,
): PathLinkTarget | null | undefined => {
  const scope = usePathLinkScope();
  const [resolution, setResolution] = useState<Resolution | null>(null);
  // The run is deliberately not a dependency: a follow-up starts a new run
  // on the same worktree, and re-resolving every reference in the
  // conversation for it would fire one probe per rendered span on send.
  const { taskId, projectId } = scope;
  const key = text
    ? `${taskId ?? ""}\u0000${projectId ?? ""}\u0000${text}`
    : null;

  useEffect(() => {
    if (!key || !text) return;

    let active = true;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = (delay: number) => {
      timer = setTimeout(() => {
        resolvePathLink(text, { taskId, projectId }).then(
          (target) => {
            if (active) setResolution({ key, target });
          },
          () => {
            if (!active) return;
            failures += 1;
            attempt(retryDelay(failures));
          },
        );
      }, delay);
    };
    attempt(SETTLE_MS);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, text, taskId, projectId]);

  if (!key) return null;
  // A resolution for different text belongs to what the reader is no longer
  // reading; until the current text resolves, its answer is unknown.
  return resolution?.key === key ? resolution.target : undefined;
};

/**
 * Activate a resolved reference: files open as an editor tab (scrolled to the
 * referenced line when there is one), directories are handed to the OS file
 * manager, which is the only thing that can show them.
 */
export const useOpenPathLink = (): ((target: PathLinkTarget) => void) => {
  const { taskRunId } = usePathLinkScope();

  return useCallback(
    (target: PathLinkTarget) => {
      if (target.kind === "directory") {
        void window.desktop?.openPath?.(target.absolutePath);
        return;
      }
      const { openFile, requestEditorReveal } = useFilesStore.getState();
      openFile(target.absolutePath, taskRunId ?? undefined);
      if (target.line !== null) {
        requestEditorReveal(target.absolutePath, target.line);
      }
    },
    [taskRunId],
  );
};
