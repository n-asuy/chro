/**
 * Vault indexer for .cbase
 * Scans workspace files matching dataset patterns and extracts frontmatter properties
 * into a queryable in-memory index.
 */

import { listProjectEntries, readProjectFile } from "@/lib/project-client";
import type { DesktopWorkspaceEntry } from "@/types/desktop";
import { parseFrontmatter } from "../files/lib/frontmatter";
import { matchesDataset } from "./glob";
import type { LensDataset, LensRow } from "./types";

export { matchesDataset } from "./glob";

type WorkspaceFileEntry = {
  relativePath: string;
  displayName: string;
  modifiedAt?: string | null;
};

/** Recursively collect file entries from API results. */
function collectFileEntries(
  entries: DesktopWorkspaceEntry[],
): WorkspaceFileEntry[] {
  const result: WorkspaceFileEntry[] = [];
  const stack = [...entries];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) continue;

    if (entry.type === "file") {
      result.push({
        relativePath: entry.relativePath,
        displayName: entry.displayName,
        modifiedAt: entry.modifiedAt,
      });
      continue;
    }

    if (entry.children?.length) {
      stack.push(...entry.children);
    }
  }
  return result;
}

/**
 * Index workspace files matching the dataset patterns.
 * Reads each matching file's frontmatter and returns LensRow entries.
 *
 * @param projectId - The project ID for API calls
 * @param dataset - Dataset definition with include/exclude patterns
 * @param signal - Optional AbortSignal for cancellation
 * @returns Array of LensRow with extracted property values
 */
export async function indexWorkspaceFiles(
  projectId: string,
  dataset: LensDataset,
  signal?: AbortSignal,
): Promise<LensRow[]> {
  if (signal?.aborted) return [];

  const entries = await listProjectEntries(projectId, {
    recursive: true,
    detail: "basic",
  });
  const allFiles = collectFileEntries(entries);

  const matchingFiles = allFiles.filter((file) => {
    return matchesDataset(file.relativePath, dataset);
  });

  const CONCURRENCY = 10;
  const rows: LensRow[] = [];

  for (let i = 0; i < matchingFiles.length; i += CONCURRENCY) {
    if (signal?.aborted) break;

    const batch = matchingFiles.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        if (signal?.aborted) {
          return null;
        }

        const relativePath = file.relativePath;
        try {
          const workspaceFile = await readProjectFile(projectId, relativePath);
          const { frontmatter } = parseFrontmatter(workspaceFile.content);
          const modifiedAt =
            workspaceFile.modifiedAt ?? file.modifiedAt ?? null;
          return {
            filePath: relativePath,
            displayName: file.displayName,
            ...(modifiedAt ? { modifiedAt } : {}),
            values: frontmatter as Record<string, unknown>,
          } satisfies LensRow;
        } catch {
          return null;
        }
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        rows.push(result.value);
      }
    }
  }

  return rows;
}
