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
 * Resolve `text` to an existing file or directory, or `null`.
 *
 * Renderers call this to decide whether to decorate the text as a link at all,
 * so a link is never shown for something that cannot be opened.
 */
/**
 * How long a reference must hold still before it is worth resolving. A message
 * streams in token by token, so `~/notes/report.html` passes through a dozen
 * prefixes that name nothing; waiting for the text to settle spends one probe
 * on the final reference instead of one on each prefix.
 */
const SETTLE_MS = 150;

export const usePathLink = (text: string | null): PathLinkTarget | null => {
  const scope = usePathLinkScope();
  const [target, setTarget] = useState<PathLinkTarget | null>(null);
  // The run is deliberately not a dependency: a follow-up starts a new run
  // on the same worktree, and re-resolving every reference in the
  // conversation for it would fire one probe per rendered span on send.
  const { taskId, projectId } = scope;

  useEffect(() => {
    // The previous target belonged to the previous text: drop it rather than
    // leave a link pointing somewhere the reader is no longer reading.
    setTarget(null);
    if (!text) return;

    let active = true;
    const timer = setTimeout(() => {
      void resolvePathLink(text, { taskId, projectId }).then((resolved) => {
        if (active) setTarget(resolved);
      });
    }, SETTLE_MS);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [text, taskId, projectId]);

  return target;
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
