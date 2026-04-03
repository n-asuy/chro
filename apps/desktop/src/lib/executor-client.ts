import { desktopFetch } from "./backend-client";

// Base coding agent types (matches BaseCodingAgent enum in Rust)
export type BaseCodingAgent = "CLAUDE_CODE" | "CODEX";

// Current executor profile selection
export type ExecutorProfileId = {
  executor: BaseCodingAgent;
  variant?: string | null;
};

// All executor configurations
type CodingAgentConfig = Record<string, unknown>;
type ExecutorConfig = Record<string, CodingAgentConfig>;

export type ExecutorConfigs = {
  executors: Record<BaseCodingAgent, ExecutorConfig>;
};

// Model preset for display
type ExecutorModelPreset = {
  id: string;
  name: string;
};

export type ExecutorProfileOptions = {
  anthropic_models: ExecutorModelPreset[];
};

type ExecutorProfileResponse = {
  profile: ExecutorProfileId;
  profiles: ExecutorConfigs;
  options: ExecutorProfileOptions;
};

export type UpdateExecutorProfileRequest = {
  executor?: BaseCodingAgent;
  variant?: string | null;
};

type ClaudeVersionResult =
  | {
      ok: true;
      version: string;
      command: string;
      resolved_path: string | null;
    }
  | {
      ok: false;
      error: "COMMAND_NOT_FOUND" | "EXECUTION_FAILED" | "UNEXPECTED_ERROR";
      message: string;
      command: string | null;
      resolved_path: string | null;
    };

export const detectClaudeVersion = async (): Promise<ClaudeVersionResult> => {
  return desktopFetch<ClaudeVersionResult>("/rpc/executor/detect");
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

// Auth status types (matches AvailabilityInfo enum in Rust)
export type AvailabilityInfo =
  | { type: "LOGIN_DETECTED"; last_auth_timestamp: number }
  | { type: "INSTALLATION_FOUND" }
  | { type: "NOT_FOUND" };

export type AuthStatusResult = {
  claude_code: AvailabilityInfo;
  codex: AvailabilityInfo;
};

export type ExecutorInstallInfo = {
  installed: boolean;
  command: string;
  resolved_path: string | null;
};

export type ExecutorInstallStatusResult = {
  claude_code: ExecutorInstallInfo;
  codex: ExecutorInstallInfo;
};

export type AuthLoginResult = {
  ok: boolean;
  executor: BaseCodingAgent;
  message: string | null;
  auth_url: string | null;
};

export const fetchAuthStatus = async (): Promise<AuthStatusResult> => {
  return desktopFetch<AuthStatusResult>("/rpc/executor/auth-status");
};

export const fetchExecutorInstallStatus =
  async (): Promise<ExecutorInstallStatusResult> => {
    return desktopFetch<ExecutorInstallStatusResult>(
      "/rpc/executor/install-status",
    );
  };

export const triggerAuthLogin = async (
  executor: BaseCodingAgent,
): Promise<AuthLoginResult> => {
  return desktopFetch<AuthLoginResult>("/rpc/executor/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ executor }),
  });
};
