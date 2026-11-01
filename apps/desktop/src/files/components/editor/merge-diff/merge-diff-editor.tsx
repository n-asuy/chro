import {
  type TextFileRoot,
  useTextFileDocument,
} from "@/files/hooks/use-text-file-document";
import { textFileKey } from "@/files/state/text-file-documents";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MergeDiffPane } from "./merge-diff-pane";
import type { MergeDiffLayout } from "./merge-diff-view";

type MergeDiffEditorProps = {
  /** Repository-relative path of the changed file. */
  path: string;
  original: string;
  /** The changed text as the diff saw it; shown until the file is read. */
  modified: string;
  layout: MergeDiffLayout;
  /** The checkout the working file lives in: a session worktree or the project. */
  projectId: string | null;
  taskRunId: string | null;
  /** False when there is no working file to write (e.g. it was deleted). */
  editable: boolean;
};

/**
 * A changed text file shown as a diff whose working side is the file itself:
 * typing, undo and reverting a block all save through the same document as
 * the file tab, and changes made on disk flow back in.
 */
export function MergeDiffEditor({
  path,
  original,
  modified,
  layout,
  projectId,
  taskRunId,
  editable,
}: MergeDiffEditorProps) {
  const [text, setText] = useState(modified);

  const root = useMemo<TextFileRoot | null>(() => {
    if (!editable) return null;
    if (taskRunId) return { kind: "task-run", taskRunId };
    if (projectId) return { kind: "project", projectId };
    return null;
  }, [editable, projectId, taskRunId]);
  const writable = root !== null;
  // Same document as the file tab, which keys files by their vault path.
  const docKey = writable
    ? textFileKey({
        projectId,
        taskRunId,
        path: path.startsWith("/") ? path : `/${path}`,
      })
    : null;

  const { load, edit, save } = useTextFileDocument({
    docKey,
    root,
    relativePath: root ? path : null,
    enabled: writable,
    onExternalText: setText,
  });

  const handleEdit = useCallback(
    (next: string) => {
      setText(next);
      edit(next);
    },
    [edit],
  );
  const handleSave = useCallback(() => void save(), [save]);

  // A writable diff edits the file on disk, which may already be ahead of
  // the diff snapshot (or hold unsaved text from an open file tab).
  useEffect(() => {
    if (!writable) return;
    let cancelled = false;
    load()
      .then(({ file, text: loaded }) => {
        if (!cancelled && !file.truncated) setText(loaded);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [writable, load]);

  // A read-only diff simply follows the snapshot.
  useEffect(() => {
    if (!writable) setText(modified);
  }, [writable, modified]);

  return (
    <MergeDiffPane
      original={original}
      text={text}
      layout={layout}
      editable={writable}
      onEdit={handleEdit}
      onSave={handleSave}
    />
  );
}
