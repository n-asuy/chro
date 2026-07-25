/**
 * RPC client for the backend cbase engine.
 *
 * Parsing, indexing, schema inference, and view execution all run server-side;
 * the frontend only sends the raw file content (or an updated definition) and
 * renders the materialized document it receives back.
 */

import { desktopFetch } from "@/lib/backend-client";
import type { CbaseDefinition, CbaseDocument, CbaseProperty } from "./types";

const jsonInit = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal,
});

export interface QueryCbaseOptions {
  viewId?: string;
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}

/** Parse, index, and materialize a `.cbase` file for the given project. */
export const queryCbase = async (
  projectId: string,
  content: string,
  basePath?: string,
  options: QueryCbaseOptions = {},
): Promise<CbaseDocument> =>
  desktopFetch<CbaseDocument>(
    `/rpc/projects/${projectId}/cbase/query`,
    jsonInit(
      {
        content,
        basePath,
        viewId: options.viewId,
        offset: options.offset,
        limit: options.limit,
      },
      options.signal,
    ),
  );

/** Response from persisting UI-driven changes back to a `.cbase` file. */
export interface PersistCbaseResult {
  /** The serialized YAML written to disk */
  content: string;
  /** The refreshed document after the write */
  document: CbaseDocument;
}

/**
 * Persist a UI-driven definition change: the backend backfills any referenced
 * inferred properties, serializes the definition, writes the file, and returns
 * the refreshed document.
 */
export const persistCbase = async (
  projectId: string,
  basePath: string,
  definition: CbaseDefinition,
  properties: Record<string, CbaseProperty>,
  viewId?: string,
): Promise<PersistCbaseResult> =>
  desktopFetch<PersistCbaseResult>(
    `/rpc/projects/${projectId}/cbase/persist`,
    jsonInit({ basePath, definition, properties, viewId }),
  );

/**
 * Rewrite one frontmatter property of a row file. The caller shows the value
 * optimistically; the worktree watcher event triggers the re-query that
 * settles the table, so nothing is returned.
 */
export const setCbaseProperty = async (
  projectId: string,
  filePath: string,
  key: string,
  value: unknown,
): Promise<void> => {
  await desktopFetch<Record<string, never>>(
    `/rpc/projects/${projectId}/cbase/set-property`,
    jsonInit({ filePath, key, value: value ?? null }),
  );
};
