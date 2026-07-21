import { desktopFetch } from "./backend-client";

// Base coding agent types (matches BaseCodingAgent enum in Rust)
export type BaseCodingAgent = "CLAUDE_CODE" | "CODEX" | "PI";

// Reasoning effort (matches ReasoningEffort enum in Rust, kebab-case)
export type ReasoningEffort = "low" | "medium" | "high" | "x-high";

// Output speed (matches SpeedMode enum in Rust). `fast` maps to Claude Code's
// fast mode (`speed: "fast"`), currently Opus-only; `standard` is the default.
export type SpeedMode = "standard" | "fast";

// Current executor profile selection
export type ExecutorProfileId = {
  executor: BaseCodingAgent;
  variant?: string | null;
  // Optional per-request overrides applied on top of the resolved variant.
  model?: string | null;
  reasoning_effort?: ReasoningEffort | null;
  speed?: SpeedMode | null;
};

// All executor configurations
type CodingAgentConfig = Record<string, unknown>;
type ExecutorConfig = Record<string, CodingAgentConfig>;

export type ExecutorConfigs = {
  executors: Record<BaseCodingAgent, ExecutorConfig>;
};

type ExecutorProfileResponse = {
  profile: ExecutorProfileId;
  profiles: ExecutorConfigs;
};

export type UpdateExecutorProfileRequest = {
  executor?: BaseCodingAgent;
  variant?: string | null;
};

export const fetchExecutorProfile =
  async (): Promise<ExecutorProfileResponse> => {
    return desktopFetch<ExecutorProfileResponse>("/rpc/executor/profile");
  };

export const updateExecutorProfile = async (
  payload: UpdateExecutorProfileRequest,
): Promise<ExecutorProfileResponse> => {
  return desktopFetch<ExecutorProfileResponse>("/rpc/executor/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
};

// MCP status check types
type McpServerStatus = {
  name: string;
  command: string;
  connected: boolean;
};

export type McpStatusResult = {
  ok: boolean;
  servers: McpServerStatus[];
  error?: string | null;
  message?: string | null;
};

export const checkMcpStatus = async (
  executor: BaseCodingAgent,
): Promise<McpStatusResult> => {
  const params = new URLSearchParams({ executor });
  return desktopFetch<McpStatusResult>(
    `/rpc/executor/mcp-status?${params.toString()}`,
  );
};

export type ExecutorInstallInfo = {
  installed: boolean;
  command: string;
  resolved_path: string | null;
  detected_version: string | null;
};

export type ExecutorInstallStatusResult = {
  claude_code: ExecutorInstallInfo;
  codex: ExecutorInstallInfo;
  pi: ExecutorInstallInfo;
  git: ExecutorInstallInfo;
};

/** Tools whose presence onboarding reports. Chro detects, it does not install. */
export type DetectableTool = BaseCodingAgent | "GIT";

// A pi model the user can select. `value` is pi's `provider/id` form, passed
// verbatim as `--model`; `label` is the human-facing name.
export type PiModelOption = {
  value: string;
  label: string;
  provider: string;
};

let piModelsCache: Promise<PiModelOption[]> | null = null;

/**
 * pi's configured models, queried from the agent (`get_available_models` +
 * custom providers), narrowed to the providers the user has set up. Cached for
 * the app session; pass `refresh` after a sign-in to re-query.
 */
export const fetchPiModels = (refresh = false): Promise<PiModelOption[]> => {
  if (refresh || !piModelsCache) {
    piModelsCache = desktopFetch<PiModelOption[]>(
      "/rpc/executor/pi/models",
    ).catch(() => []);
  }
  return piModelsCache;
};

// A provider configured in pi's auth file. Never carries the secret value.
export type PiCredentialInfo = {
  provider: string;
  /** "api_key" | "oauth" | "unknown" */
  kind: string;
};

export const fetchPiCredentials = async (): Promise<PiCredentialInfo[]> => {
  return desktopFetch<PiCredentialInfo[]>("/rpc/executor/pi/credentials");
};

type PiCredentialMutationResult = { ok: boolean; message?: string };

/** Store an API key for a pi provider (written to `~/.pi/agent/auth.json`). */
export const setPiApiKey = async (
  provider: string,
  key: string,
): Promise<PiCredentialMutationResult> => {
  const result = await desktopFetch<PiCredentialMutationResult>(
    "/rpc/executor/pi/api-key",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, key }),
    },
  );
  // New credentials may unlock new providers' models.
  if (result.ok) void fetchPiModels(true);
  return result;
};

export const deletePiCredential = async (
  provider: string,
): Promise<PiCredentialMutationResult> => {
  const params = new URLSearchParams({ provider });
  const result = await desktopFetch<PiCredentialMutationResult>(
    `/rpc/executor/pi/api-key?${params.toString()}`,
    { method: "DELETE" },
  );
  if (result.ok) void fetchPiModels(true);
  return result;
};

export const fetchExecutorInstallStatus =
  async (): Promise<ExecutorInstallStatusResult> => {
    return desktopFetch<ExecutorInstallStatusResult>(
      "/rpc/executor/install-status",
    );
  };
