import { listProjectEntries, readProjectFile } from "@/lib/project-client";
import type { DesktopWorkspaceEntry } from "@/types/desktop";
import { useCallback, useEffect, useRef, useState } from "react";
import { type FileEntry, buildGraphData } from "../lib/graph-builder";
import type { GraphData } from "../types";

const CONCURRENCY = 20;
const MAX_FILE_SIZE = 200_000;
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx"]);

interface FileStub {
  relativePath: string;
  displayName: string;
  size?: number | null;
}

function collectMarkdownFiles(entries: DesktopWorkspaceEntry[]): FileStub[] {
  const result: FileStub[] = [];
  const stack = [...entries];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) continue;

    if (
      entry.type === "file" &&
      MARKDOWN_EXTENSIONS.has(entry.extension ?? "")
    ) {
      result.push({
        relativePath: entry.relativePath,
        displayName: entry.displayName,
        size: entry.size,
      });
      continue;
    }

    if (entry.children?.length) {
      stack.push(...entry.children);
    }
  }
  return result;
}

export function useGraphData(projectId: string | null) {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const entries = await listProjectEntries(projectId, {
        recursive: true,
        detail: "basic",
      });

      if (controller.signal.aborted) return;

      const markdownFiles = collectMarkdownFiles(entries);
      const fileEntries: FileEntry[] = [];

      for (let i = 0; i < markdownFiles.length; i += CONCURRENCY) {
        if (controller.signal.aborted) break;

        const batch = markdownFiles.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (file) => {
            if (controller.signal.aborted) return null;
            if (file.size && file.size > MAX_FILE_SIZE) {
              return {
                relativePath: file.relativePath,
                displayName: file.displayName,
                content: "",
              } satisfies FileEntry;
            }
            const wsFile = await readProjectFile(projectId, file.relativePath);
            return {
              relativePath: file.relativePath,
              displayName: file.displayName,
              content: wsFile.content,
            } satisfies FileEntry;
          }),
        );

        for (const result of results) {
          if (result.status === "fulfilled" && result.value) {
            fileEntries.push(result.value);
          }
        }
      }

      if (controller.signal.aborted) return;

      setGraphData(buildGraphData(fileEntries));
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "Failed to build graph");
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  return { graphData, loading, error, reload: load };
}
