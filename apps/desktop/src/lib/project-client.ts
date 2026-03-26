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

type ProjectFileEventType =
  | "created"
  | "modified"
  | "deleted"
  | "renamed";

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

export type ProjectSearchResult = {
  path: string;
  is_file: boolean;
  match_type: SearchMatchType;
};

type SearchMode = "taskform" | "settings";

type ProjectSearchResponse = {
  results: ProjectSearchResult[];
};

export const searchProjectFiles = async (
  projectId: string,
  query: string,
  options?: { mode?: SearchMode; limit?: number },
): Promise<ProjectSearchResult[]> => {
  if (!query.trim()) {
    return [];
  }

  const params = new URLSearchParams({ q: query });
  if (options?.mode) {
    params.set("mode", options.mode);
  }
  if (options?.limit) {
    params.set("limit", options.limit.toString());
  }

  const { results } = await desktopFetch<ProjectSearchResponse>(
    `/rpc/projects/${projectId}/search?${params.toString()}`,
  );
  return results;
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

// --- Task transcript ---

type GenerateTranscriptResponse = {
  file_path: string;
};

export const generateTaskTranscript = async (
  taskId: string,
  workspacePath: string,
  containerRef?: string | null,
): Promise<string> => {
  const { file_path } = await desktopFetch<GenerateTranscriptResponse>(
    `/rpc/tasks/${taskId}/transcript`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_path: workspacePath,
        container_ref: containerRef ?? undefined,
      }),
    },
  );
  return file_path;
};
