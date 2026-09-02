import type { MediaKind } from "@/files/media-types";
import type {
  DesktopWorkspaceEntry,
  DesktopWorkspaceFile,
} from "@/types/desktop";
import { desktopFetch, getBackendBaseUrl } from "./backend-client";

const httpToWs = (url: string): string =>
  url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

type ProjectEntryResponse = {
  type: "file" | "directory";
  name: string;
  displayName: string;
  relativePath: string;
  extension: string | null;
  hasChildren?: boolean;
  size?: number | null;
  modifiedAt?: string | null;
  createdAt?: string | null;
  children?: ProjectEntryResponse[];
};

type ProjectFileResponse = {
  relative_path: string;
  content: string;
  size: number;
  truncated?: boolean;
  modified_at?: string | null;
};

type ProjectEntriesEnvelope = {
  entries: ProjectEntryResponse[];
};

type ProjectFileEnvelope = {
  file: ProjectFileResponse;
};

const toDesktopEntry = (
  entry: ProjectEntryResponse,
): DesktopWorkspaceEntry => ({
  type: entry.type,
  name: entry.name,
  displayName: entry.displayName,
  relativePath: entry.relativePath,
  extension: entry.extension,
  hasChildren: entry.hasChildren,
  size: entry.size,
  modifiedAt: entry.modifiedAt,
  createdAt: entry.createdAt,
  children: entry.children?.map(toDesktopEntry),
});

const toDesktopFile = (file: ProjectFileResponse): DesktopWorkspaceFile => ({
  relativePath: file.relative_path,
  content: file.content,
  size: file.size,
  truncated: file.truncated ?? false,
  modifiedAt: file.modified_at ?? null,
});

type ListProjectEntriesOptions = {
  relativePath?: string;
  recursive?: boolean;
  detail?: "basic" | "full";
};

export const listProjectEntries = async (
  projectId: string,
  options?: ListProjectEntriesOptions,
): Promise<DesktopWorkspaceEntry[]> => {
  const params = new URLSearchParams();
  if (options?.relativePath) {
    params.set("relative_path", options.relativePath);
  }
  if (options?.recursive) {
    params.set("recursive", "true");
  }
  if (options?.detail) {
    params.set("detail", options.detail);
  }
  const query = params.toString();
  const { entries } = await desktopFetch<ProjectEntriesEnvelope>(
    `/rpc/projects/${projectId}/entries${query ? `?${query}` : ""}`,
  );
  return entries.map(toDesktopEntry);
};

type ListWorkspaceEntriesOptions = {
  relativePath?: string;
  recursive?: boolean;
  detail?: "basic" | "full";
};

/**
 * List entries at any absolute filesystem path. Used by ad-hoc workspace
 * roots (folders added to the project via "Add Folder to Project") so each
 * extra root can be browsed independently of the bound project.
 */
export const listWorkspaceEntriesAtPath = async (
  absolutePath: string,
  options?: ListWorkspaceEntriesOptions,
): Promise<DesktopWorkspaceEntry[]> => {
  const params = new URLSearchParams({ abs_path: absolutePath });
  if (options?.relativePath) {
    params.set("relative_path", options.relativePath);
  }
  if (options?.recursive) {
    params.set("recursive", "true");
  }
  if (options?.detail) {
    params.set("detail", options.detail);
  }
  const { entries } = await desktopFetch<ProjectEntriesEnvelope>(
    `/rpc/filesystem/workspace-entries?${params.toString()}`,
  );
  return entries.map(toDesktopEntry);
};

/**
 * List entries inside a task run's worktree (sandbox). Mirrors
 * {@link listProjectEntries} but roots the listing at the run's worktree so
 * the file tree can browse a session's sandbox rather than the project's main
 * checkout. For "local" runs the server resolves this to the project checkout.
 */
export const listTaskRunEntries = async (
  taskRunId: string,
  options?: ListProjectEntriesOptions,
): Promise<DesktopWorkspaceEntry[]> => {
  const params = new URLSearchParams();
  if (options?.relativePath) {
    params.set("relative_path", options.relativePath);
  }
  if (options?.recursive) {
    params.set("recursive", "true");
  }
  if (options?.detail) {
    params.set("detail", options.detail);
  }
  const query = params.toString();
  const { entries } = await desktopFetch<ProjectEntriesEnvelope>(
    `/rpc/task-runs/${taskRunId}/entries${query ? `?${query}` : ""}`,
  );
  return entries.map(toDesktopEntry);
};

/** A renderable media artifact surfaced by the gallery. */
export type WorkspaceMediaItem = {
  relativePath: string;
  kind: MediaKind;
  size: number | null;
  modifiedAt: string | null;
};

export type WorkspaceMediaListing = {
  items: WorkspaceMediaItem[];
  /** True when the server capped the result; the gallery surfaces this. */
  truncated: boolean;
};

type MediaItemResponse = {
  relativePath: string;
  kind: string;
  size?: number | null;
  modifiedAt?: string | null;
};

type MediaEnvelope = {
  items: MediaItemResponse[];
  truncated: boolean;
};

const toMediaItem = (item: MediaItemResponse): WorkspaceMediaItem => ({
  relativePath: item.relativePath,
  kind: item.kind === "video" ? "video" : "image",
  size: item.size ?? null,
  modifiedAt: item.modifiedAt ?? null,
});

const mediaQuery = (limit?: number): string => {
  if (limit == null) return "";
  const params = new URLSearchParams({ limit: String(limit) });
  return `?${params.toString()}`;
};

/**
 * List renderable media (images, video) under the project's main checkout,
 * gitignore-aware and newest-first. Byte payloads are fetched separately via
 * {@link getProjectBinaryFileUrl}.
 */
export const listProjectMedia = async (
  projectId: string,
  options?: { limit?: number },
): Promise<WorkspaceMediaListing> => {
  const envelope = await desktopFetch<MediaEnvelope>(
    `/rpc/projects/${projectId}/media${mediaQuery(options?.limit)}`,
  );
  return {
    items: envelope.items.map(toMediaItem),
    truncated: envelope.truncated,
  };
};

/** List renderable media inside a task run's worktree (a session's sandbox). */
export const listTaskRunMedia = async (
  taskRunId: string,
  options?: { limit?: number },
): Promise<WorkspaceMediaListing> => {
  const envelope = await desktopFetch<MediaEnvelope>(
    `/rpc/task-runs/${taskRunId}/media${mediaQuery(options?.limit)}`,
  );
  return {
    items: envelope.items.map(toMediaItem),
    truncated: envelope.truncated,
  };
};

export const readProjectFile = async (
  projectId: string,
  relativePath: string,
): Promise<DesktopWorkspaceFile> => {
  const params = new URLSearchParams({ relative_path: relativePath });
  const { file } = await desktopFetch<ProjectFileEnvelope>(
    `/rpc/projects/${projectId}/file?${params.toString()}`,
  );
  return toDesktopFile(file);
};

/**
 * Read a text file from an arbitrary absolute workspace root. Used by
 * additional file-tree roots added through "Add Folder to Project".
 */
export const readWorkspaceFileAtPath = async (
  absolutePath: string,
  relativePath: string,
): Promise<DesktopWorkspaceFile> => {
  const params = new URLSearchParams({
    abs_path: absolutePath,
    relative_path: relativePath,
  });
  const { file } = await desktopFetch<ProjectFileEnvelope>(
    `/rpc/filesystem/workspace-file?${params.toString()}`,
  );
  return toDesktopFile(file);
};

/**
 * Read a text file from a task run's worktree (container_ref or workspace_path).
 * Used when opening files clicked from a session view so the user sees the
 * worktree's version of the file rather than the project main checkout.
 */
export const readTaskRunFile = async (
  taskRunId: string,
  relativePath: string,
): Promise<DesktopWorkspaceFile> => {
  const params = new URLSearchParams({ relative_path: relativePath });
  const { file } = await desktopFetch<ProjectFileEnvelope>(
    `/rpc/task-runs/${taskRunId}/file?${params.toString()}`,
  );
  return toDesktopFile(file);
};

export const writeProjectFile = async (
  projectId: string,
  relativePath: string,
  content: string,
): Promise<DesktopWorkspaceFile> => {
  const { file } = await desktopFetch<ProjectFileEnvelope>(
    `/rpc/projects/${projectId}/file`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ relative_path: relativePath, content }),
    },
  );
  return toDesktopFile(file);
};

type DeleteProjectFileResponse = {
  deleted_path: string;
};

export const deleteProjectFile = async (
  projectId: string,
  relativePath: string,
): Promise<string> => {
  const params = new URLSearchParams({ relative_path: relativePath });
  const { deleted_path } = await desktopFetch<DeleteProjectFileResponse>(
    `/rpc/projects/${projectId}/file?${params.toString()}`,
    { method: "DELETE" },
  );
  return deleted_path;
};

type CreateDirectoryResponse = {
  entry: ProjectEntryResponse;
};

export const createProjectDirectory = async (
  projectId: string,
  relativePath: string,
): Promise<DesktopWorkspaceEntry> => {
  const { entry } = await desktopFetch<CreateDirectoryResponse>(
    `/rpc/projects/${projectId}/directory`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ relative_path: relativePath }),
    },
  );
  return toDesktopEntry(entry);
};

type RenameEntryResponse = {
  new_relative_path: string;
};

export const renameProjectEntry = async (
  projectId: string,
  oldRelativePath: string,
  newRelativePath: string,
): Promise<string> => {
  const { new_relative_path } = await desktopFetch<RenameEntryResponse>(
    `/rpc/projects/${projectId}/rename`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        old_relative_path: oldRelativePath,
        new_relative_path: newRelativePath,
      }),
    },
  );
  return new_relative_path;
};

type CopyEntryResponse = {
  entry: ProjectEntryResponse;
};

export const copyProjectEntry = async (
  projectId: string,
  sourceRelativePath: string,
  destRelativePath: string,
): Promise<DesktopWorkspaceEntry> => {
  const { entry } = await desktopFetch<CopyEntryResponse>(
    `/rpc/projects/${projectId}/copy`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source_relative_path: sourceRelativePath,
        dest_relative_path: destRelativePath,
      }),
    },
  );
  return toDesktopEntry(entry);
};

type ProjectFileEventType = "created" | "modified" | "deleted" | "renamed";

export type ProjectFileEvent = {
  event_type: ProjectFileEventType;
  relative_path: string;
  is_directory: boolean;
};

/**
 * Subscribe to project file change events via WebSocket.
 * Returns an unsubscribe function.
 */
export const subscribeProjectFileEvents = (
  projectId: string,
  onFileChanged: (event: ProjectFileEvent) => void,
): (() => void) => {
  const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
  const httpUrl = `${baseUrl}/rpc/projects/${projectId}/file-events`;
  const wsUrl = httpToWs(httpUrl);
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as ProjectFileEvent;
      onFileChanged(data);
    } catch {
      console.error(
        "[project-client] Failed to parse file_changed event:",
        event.data,
      );
    }
  };

  ws.onerror = () => {
    console.warn("[project-client] File events WebSocket connection error");
  };

  return () => {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close();
  };
};

/**
 * Get the URL for a binary file (image, etc.) in the project.
 * This returns a direct URL to fetch the binary content.
 */
export const getProjectBinaryFileUrl = (
  projectId: string,
  relativePath: string,
): string => {
  const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
  const params = new URLSearchParams({ relative_path: relativePath });
  return `${baseUrl}/rpc/projects/${projectId}/binary-file?${params.toString()}`;
};

/**
 * Get the URL for a binary file from a task run's worktree.
 */
export const getTaskRunBinaryFileUrl = (
  taskRunId: string,
  relativePath: string,
): string => {
  const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
  const params = new URLSearchParams({ relative_path: relativePath });
  return `${baseUrl}/rpc/task-runs/${taskRunId}/binary-file?${params.toString()}`;
};

/**
 * Get the URL for a binary file under an arbitrary absolute workspace root.
 */
export const getWorkspaceBinaryFileUrl = (
  absolutePath: string,
  relativePath: string,
): string => {
  const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
  const params = new URLSearchParams({
    abs_path: absolutePath,
    relative_path: relativePath,
  });
  return `${baseUrl}/rpc/filesystem/workspace-binary-file?${params.toString()}`;
};

/**
 * Encode a workspace-relative path into URL path segments.
 * Each segment is percent-encoded but the slashes are preserved so that the
 * resulting URL keeps a real directory hierarchy — this is what lets relative
 * URLs inside an iframe (e.g. `<link href="style.css">`) resolve naturally.
 */
const encodeRelativePathSegments = (relativePath: string): string =>
  relativePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");

/**
 * base64url-encode a UTF-8 string. Used to embed an absolute workspace root
 * path as a single URL path segment for the workspace asset endpoint.
 */
const base64UrlEncode = (input: string): string => {
  const utf8 = unescape(encodeURIComponent(input));
  return btoa(utf8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Get a path-based asset URL for a file inside an arbitrary workspace root.
 * The root travels as a single base64url segment, so it keeps its leading
 * slash, while the remainder stays a real path hierarchy.
 */
const workspaceAssetUrl = (rootPath: string, relativePath: string): string => {
  const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
  const encodedRoot = base64UrlEncode(rootPath);
  return `${baseUrl}/rpc/filesystem/workspace-asset/${encodedRoot}/${encodeRelativePathSegments(relativePath)}`;
};

/**
 * Asset URL for a file addressed by a host-absolute path.
 *
 * A leading slash is not a path segment, so an absolute path fed to a
 * scope-relative asset route arrives with its slash stripped and is then
 * joined under the wrong root. Carrying the containing directory as the
 * encoded root instead keeps the path absolute and still lets sibling
 * references inside served HTML resolve through the same endpoint.
 */
const absoluteAssetUrl = (absolutePath: string): string => {
  const index = absolutePath.lastIndexOf("/");
  const directory = index <= 0 ? "/" : absolutePath.slice(0, index);
  return workspaceAssetUrl(directory, absolutePath.slice(index + 1));
};

/** Host-absolute paths cannot be expressed as scope-relative URL segments. */
const isHostAbsolutePath = (path: string): boolean => path.startsWith("/");

/**
 * Get a path-based asset URL for a project file. Unlike `getProjectBinaryFileUrl`
 * (which uses a query parameter), this puts the relative path directly into the
 * URL so that relative resources referenced from served HTML (CSS, JS, images)
 * resolve via the same endpoint.
 */
export const getProjectAssetUrl = (
  projectId: string,
  relativePath: string,
): string => {
  if (isHostAbsolutePath(relativePath)) return absoluteAssetUrl(relativePath);
  const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
  return `${baseUrl}/rpc/projects/${projectId}/asset/${encodeRelativePathSegments(relativePath)}`;
};

/**
 * Get a path-based asset URL for a file inside a task run worktree.
 */
export const getTaskRunAssetUrl = (
  taskRunId: string,
  relativePath: string,
): string => {
  if (isHostAbsolutePath(relativePath)) return absoluteAssetUrl(relativePath);
  const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
  return `${baseUrl}/rpc/task-runs/${taskRunId}/asset/${encodeRelativePathSegments(relativePath)}`;
};

/**
 * Get a path-based asset URL for a file inside an arbitrary workspace root.
 */
export const getWorkspaceAssetUrl = (
  absolutePath: string,
  relativePath: string,
): string => {
  if (isHostAbsolutePath(relativePath)) return absoluteAssetUrl(relativePath);
  return workspaceAssetUrl(absolutePath, relativePath);
};

type UploadBinaryFileResponse = {
  relative_path: string;
  size: number;
  mime_type: string;
};

/**
 * Upload a binary file (image, etc.) to the project.
 */
export const uploadProjectBinaryFile = async (
  projectId: string,
  relativePath: string,
  file: File | Blob,
): Promise<UploadBinaryFileResponse> => {
  const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
  const formData = new FormData();
  formData.append("relative_path", relativePath);
  formData.append("file", file);

  const response = await fetch(
    `${baseUrl}/rpc/projects/${projectId}/binary-file`,
    {
      method: "POST",
      body: formData,
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to upload file: ${text}`);
  }

  return response.json();
};

export type SearchMatchType =
  | "FileName"
  | "DirectoryName"
  | "FullPath"
  | "ContentMatch";

/**
 * A single matching line for a content search result. `ranges` are
 * `[start, end)` UTF-16 offsets into `line_content`, ready to slice for
 * highlighting.
 */
export type SearchLineMatch = {
  line_number: number;
  line_content: string;
  ranges: [number, number][];
};

export type ProjectSearchResult = {
  path: string;
  is_file: boolean;
  match_type: SearchMatchType;
  /** Matching lines for content search; empty for name/path results. */
  line_matches: SearchLineMatch[];
  /** Last-modified time (RFC3339) for content results; null for name search. */
  modified_at: string | null;
};

type SearchMode = "taskform" | "settings";

/** "name" (default) matches file names/paths; "content" runs full-text search. */
export type SearchKind = "name" | "content";

/** Case handling for content search; omit for smart-case (uppercase = sensitive). */
export type SearchCase = "sensitive" | "insensitive";

/** Content-search ordering; "relevance" is the default. */
export type ContentSortOrder =
  | "relevance"
  | "modified-desc"
  | "modified-asc"
  | "name-asc"
  | "name-desc"
  | "path-asc"
  | "path-desc";

type ProjectSearchResponse = {
  results: ProjectSearchResult[];
  total_files: number;
  total_line_matches: number;
  truncated: boolean;
};

/** Content search results plus totals describing the full collected set. */
export type ProjectContentSearchOutcome = {
  results: ProjectSearchResult[];
  /** Files matched before the server's collect cap (>= results.length). */
  totalFiles: number;
  /** Matching lines across all collected files (before the per-file cap). */
  totalLineMatches: number;
  /** True when the collect cap was hit, so the totals are lower bounds. */
  truncated: boolean;
};

const runProjectSearch = (
  projectId: string,
  query: string,
  options?: {
    mode?: SearchMode;
    limit?: number;
    kind?: SearchKind;
    case?: SearchCase;
    sort?: ContentSortOrder;
    filesOnly?: boolean;
    signal?: AbortSignal;
  },
): Promise<ProjectSearchResponse> => {
  const params = new URLSearchParams({ q: query });
  if (options?.mode) {
    params.set("mode", options.mode);
  }
  if (options?.filesOnly) {
    params.set("files_only", "true");
  }
  if (options?.limit) {
    params.set("limit", options.limit.toString());
  }
  if (options?.kind) {
    params.set("kind", options.kind);
  }
  if (options?.case) {
    params.set("case", options.case);
  }
  if (options?.sort) {
    params.set("sort", options.sort);
  }

  return desktopFetch<ProjectSearchResponse>(
    `/rpc/projects/${projectId}/search?${params.toString()}`,
    { signal: options?.signal },
  );
};

export const searchProjectFiles = async (
  projectId: string,
  query: string,
  options?: {
    mode?: SearchMode;
    limit?: number;
    kind?: SearchKind;
    case?: SearchCase;
    signal?: AbortSignal;
  },
): Promise<ProjectSearchResult[]> => {
  if (!query.trim()) {
    return [];
  }
  const { results } = await runProjectSearch(projectId, query, options);
  return results;
};

/**
 * The repository's most relevant files with no query: the server matches every
 * indexed entry and its git-history ranking surfaces recently touched files.
 * Default suggestion list for pickers opened without input. Directories are
 * dropped server-side so they never consume result slots.
 */
export const listTopProjectFiles = async (
  projectId: string,
  options?: { limit?: number; signal?: AbortSignal },
): Promise<ProjectSearchResult[]> => {
  const { results } = await runProjectSearch(projectId, "", {
    ...options,
    filesOnly: true,
  });
  return results;
};

/**
 * Where a resolved file reference lives: the workspace root it was found
 * under plus the path relative to that root, or `null`s when unresolved.
 */
export type ResolvedFileLocation = {
  root: string | null;
  relative_path: string | null;
};

/**
 * Resolve a file reference (bare name, extensionless wikilink target, or path
 * suffix) against the project's name index: NFC/case-insensitive, `.md`
 * appended to extensionless references, shortest path wins among duplicates.
 */
export const resolveProjectFile = (
  projectId: string,
  name: string,
): Promise<ResolvedFileLocation> => {
  const params = new URLSearchParams({ name });
  return desktopFetch<ResolvedFileLocation>(
    `/rpc/projects/${projectId}/resolve-file?${params.toString()}`,
  );
};

/**
 * {@link resolveProjectFile} but against a task run's candidate roots in
 * priority order (worktree, own project, sibling projects). Roots deleted
 * from disk are skipped server-side.
 */
export const resolveTaskRunFile = (
  taskRunId: string,
  name: string,
): Promise<ResolvedFileLocation> => {
  const params = new URLSearchParams({ name });
  return desktopFetch<ResolvedFileLocation>(
    `/rpc/task-runs/${taskRunId}/resolve-file?${params.toString()}`,
  );
};

/**
 * What a path-like reference from agent output actually names on disk, as
 * reported by the server's probe. `exists: false` means the reference resolves
 * to nothing and must not be rendered as a link.
 */
export type PathProbe = {
  exists: boolean;
  kind?: "file" | "directory";
  absolute_path?: string;
  root?: string;
  relative_path?: string;
  line?: number;
  column?: number;
};

type PathProbeBatch = { results: PathProbe[] };

/**
 * Probe references against a task's candidate roots (its latest run's
 * worktree, own project, sibling projects). Batched: one request carries every
 * reference a rendered message wants to check. Results are index-aligned with
 * `paths`.
 */
export const probeTaskPaths = async (
  taskId: string,
  paths: string[],
): Promise<PathProbe[]> => {
  const { results } = await desktopFetch<PathProbeBatch>(
    `/rpc/tasks/${taskId}/probe-paths`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    },
  );
  return results;
};

/** {@link probeTaskPaths} against a project checkout. */
export const probeProjectPaths = async (
  projectId: string,
  paths: string[],
): Promise<PathProbe[]> => {
  const { results } = await desktopFetch<PathProbeBatch>(
    `/rpc/projects/${projectId}/probe-paths`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    },
  );
  return results;
};

/**
 * Full-text content search that also returns totals and the truncation flag,
 * so the caller can show "N files · M matches" and flag a capped result set.
 * Ordering happens server-side per `sort`.
 */
export const searchProjectContent = async (
  projectId: string,
  query: string,
  options?: {
    limit?: number;
    case?: SearchCase;
    sort?: ContentSortOrder;
    signal?: AbortSignal;
  },
): Promise<ProjectContentSearchOutcome> => {
  if (!query.trim()) {
    return {
      results: [],
      totalFiles: 0,
      totalLineMatches: 0,
      truncated: false,
    };
  }
  const response = await runProjectSearch(projectId, query, {
    ...options,
    kind: "content",
  });
  return {
    results: response.results,
    totalFiles: response.total_files,
    totalLineMatches: response.total_line_matches,
    truncated: response.truncated,
  };
};

export const revealInFinder = async (
  projectId: string,
  relativePath: string,
): Promise<void> => {
  await desktopFetch<Record<string, never>>(
    `/rpc/projects/${projectId}/reveal-in-finder`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relative_path: relativePath }),
    },
  );
};

/**
 * Reveal a path from a task run's worktree (session sandbox) in the file
 * manager. The server resolves the path against the run's worktree rather than
 * the project checkout, so this points at the sandbox copy of the file.
 */
export const revealTaskRunInFinder = async (
  taskRunId: string,
  relativePath: string,
): Promise<void> => {
  await desktopFetch<Record<string, never>>(
    `/rpc/task-runs/${taskRunId}/reveal-in-finder`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relative_path: relativePath }),
    },
  );
};

/**
 * Resolve a worktree-relative path to its absolute on-disk path. The client
 * does not know the worktree root in session-sandbox scope, so the server
 * joins and boundary-checks the path. Used by "Copy Absolute Path".
 */
export const resolveTaskRunAbsolutePath = async (
  taskRunId: string,
  relativePath: string,
): Promise<string> => {
  const params = new URLSearchParams({ relative_path: relativePath });
  const { absolute_path } = await desktopFetch<{ absolute_path: string }>(
    `/rpc/task-runs/${taskRunId}/absolute-path?${params.toString()}`,
  );
  return absolute_path;
};
