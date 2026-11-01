import {
  type ProjectFileEvent,
  readProjectFile,
  readTaskRunFile,
  readWorkspaceFileAtPath,
  subscribeProjectFileEvents,
  subscribeTaskRunFileEvents,
  subscribeWorkspaceFileEvents,
  writeProjectFile,
  writeTaskRunFile,
  writeWorkspaceFileAtPath,
} from "@/lib/project-client";
import type { DesktopWorkspaceFile } from "@/types/desktop";
import { toast } from "@chro/ui/hooks/use-toast";
import { useCallback, useEffect, useRef } from "react";
import type { TextFileModel } from "../lib/text-file-model";
import { closeTextFile, openTextFile } from "../state/text-file-documents";

/** The checkout a file is read from and written to. */
export type TextFileRoot =
  | { kind: "project"; projectId: string }
  | { kind: "task-run"; taskRunId: string }
  | { kind: "workspace"; rootPath: string };

export const readTextFile = (
  root: TextFileRoot,
  relativePath: string,
): Promise<DesktopWorkspaceFile> => {
  switch (root.kind) {
    case "project":
      return readProjectFile(root.projectId, relativePath);
    case "task-run":
      return readTaskRunFile(root.taskRunId, relativePath);
    case "workspace":
      return readWorkspaceFileAtPath(root.rootPath, relativePath);
  }
};

const writeTextFile = async (
  root: TextFileRoot,
  relativePath: string,
  content: string,
): Promise<void> => {
  switch (root.kind) {
    case "project":
      await writeProjectFile(root.projectId, relativePath, content);
      return;
    case "task-run":
      await writeTaskRunFile(root.taskRunId, relativePath, content);
      return;
    case "workspace":
      await writeWorkspaceFileAtPath(root.rootPath, relativePath, content);
      return;
  }
};

const subscribeTextFileEvents = (
  root: TextFileRoot,
  onEvent: (event: ProjectFileEvent) => void,
): (() => void) => {
  switch (root.kind) {
    case "project":
      return subscribeProjectFileEvents(root.projectId, onEvent);
    case "task-run":
      return subscribeTaskRunFileEvents(root.taskRunId, onEvent);
    case "workspace":
      return subscribeWorkspaceFileEvents(root.rootPath, onEvent);
  }
};

/** Event paths are root-relative without a leading slash. */
const sameRelativePath = (a: string, b: string): boolean =>
  a.replace(/^\/+/, "") === b.replace(/^\/+/, "");

const reportSaveError = (relativePath: string, error: Error) => {
  toast({
    title: `Failed to save file “${relativePath}”`,
    description: `${error.message}. Make a backup of the contents of this file now to avoid losing data.`,
    variant: "warning",
    duration: Number.POSITIVE_INFINITY,
  });
};

type UseTextFileDocumentOptions = {
  /** Registry key (see `textFileKey`); null when nothing is open. */
  docKey: string | null;
  root: TextFileRoot | null;
  relativePath: string | null;
  /** False for content that must never be written back (binary, truncated). */
  enabled: boolean;
  /**
   * Push text that changed on disk (possibly merged with edits) into the view.
   * Views that cannot take new text in place omit it and do not follow disk.
   */
  onExternalText?: (text: string) => void;
};

type UseTextFileDocumentReturn = {
  /**
   * Wait for this file's in-flight save (e.g. from the tab that just closed),
   * then read it. Returns the text to display: the disk content, or the
   * unsaved text of an already-open document reconciled with it.
   */
  load: () => Promise<{ file: DesktopWorkspaceFile; text: string }>;
  /** Record the view's current text. */
  edit: (text: string) => void;
  /** Write now (Mod+S, before previewing). */
  save: () => Promise<void>;
};

/**
 * Binds an editor view to the shared text document for its file: saves
 * edits automatically, flushes on close, and follows changes made on disk by
 * agents or other tools.
 */
export function useTextFileDocument({
  docKey,
  root,
  relativePath,
  enabled,
  onExternalText,
}: UseTextFileDocumentOptions): UseTextFileDocumentReturn {
  const modelRef = useRef<TextFileModel | null>(null);
  const onExternalTextRef = useRef(onExternalText);
  onExternalTextRef.current = onExternalText;

  const active =
    enabled && docKey !== null && root !== null && relativePath !== null;
  const followsDisk = onExternalText !== undefined;
  // Root-relative path the server resolved on read. Tab paths can be virtual
  // tree paths ("/docs/a.md") that reads resolve but writes must not guess.
  const resolvedPathRef = useRef<{ path: string | null }>({ path: null });
  const rootRef = useRef(root);
  rootRef.current = root;
  const rootIdentity = root ? JSON.stringify(root) : null;

  useEffect(() => {
    const currentRoot = rootRef.current;
    if (!active || !docKey || !currentRoot || relativePath === null) return;
    // Writes go where the file was read from. A document only saves after its
    // disk baseline arrived, and every read records the resolved path first.
    const resolved: { path: string | null } = { path: null };
    resolvedPathRef.current = resolved;
    const readResolved = async () => {
      const file = await readTextFile(currentRoot, relativePath);
      resolved.path = file.relativePath;
      return file;
    };
    const model = openTextFile(
      docKey,
      (content) => {
        if (resolved.path === null) {
          return Promise.reject(new Error("File has not been read yet"));
        }
        return writeTextFile(currentRoot, resolved.path, content);
      },
      (error) => reportSaveError(relativePath, error),
    );
    modelRef.current = model;
    // A view whose content loaded before the document opened (a structured
    // viewer falling back to the text editor) still needs the disk baseline.
    if (!model.loaded) {
      readResolved()
        .then((file) => {
          if (modelRef.current === model && !file.truncated) {
            model.applyDisk(file.content);
          }
        })
        .catch(() => {});
    }

    const unsubscribe = !followsDisk
      ? () => {}
      : subscribeTextFileEvents(currentRoot, (event) => {
          if (event.is_directory) return;
          if (
            event.event_type !== "modified" &&
            event.event_type !== "created"
          ) {
            return;
          }
          const watched = resolved.path ?? relativePath;
          if (!sameRelativePath(event.relative_path, watched)) return;
          readResolved()
            .then((file) => {
              if (modelRef.current !== model || file.truncated) return;
              const result = model.applyDisk(file.content);
              if (!result) return;
              if (result.merged) {
                toast({
                  description: `“${relativePath}” has been modified externally, merging changes automatically.`,
                });
              }
              onExternalTextRef.current?.(result.data);
            })
            .catch(() => {
              // The file may have been deleted or renamed; the next event or a
              // reopen reconciles it.
            });
        });

    return () => {
      unsubscribe();
      modelRef.current = null;
      closeTextFile(docKey);
    };
    // rootIdentity stands in for `root`, whose object identity changes per render.
  }, [active, docKey, rootIdentity, relativePath, followsDisk]);

  // Flush before the window goes away.
  useEffect(() => {
    const flush = () => {
      void modelRef.current?.save();
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  const load = useCallback(async () => {
    const currentRoot = rootRef.current;
    if (!currentRoot || relativePath === null) {
      throw new Error("No file selected");
    }
    const model = modelRef.current;
    await model?.settled();
    const file = await readTextFile(currentRoot, relativePath);
    resolvedPathRef.current.path = file.relativePath;
    if (!model || modelRef.current !== model || file.truncated) {
      return { file, text: file.content };
    }
    model.applyDisk(file.content);
    return { file, text: model.data };
  }, [relativePath]);

  const edit = useCallback((text: string) => {
    modelRef.current?.setViewData(text);
  }, []);

  const save = useCallback(async () => {
    await modelRef.current?.save();
  }, []);

  return { load, edit, save };
}
