import { desktopFetch } from "./backend-client";
import type { BaseCodingAgent } from "./executor-client";

type FetchedMcpConfig = {
  configPath: string;
  exists: boolean;
  mcpConfig: Record<string, unknown>;
  parseError: string | null;
  rawContent?: string;
};

export const fetchMcpConfig = async (
  executor?: BaseCodingAgent,
): Promise<FetchedMcpConfig> => {
  const query = executor ? `?executor=${executor}` : "";
  const response = await desktopFetch<{
    config_path: string;
    exists: boolean;
    mcp_config: Record<string, unknown>;
    parse_error?: string | null;
    raw_content?: string | null;
  }>(`/rpc/mcp-config${query}`);

  return {
    configPath: response.config_path,
    exists: response.exists,
    mcpConfig: response.mcp_config,
    parseError: response.parse_error ?? null,
    rawContent: response.raw_content ?? undefined,
  };
};

type SavedMcpConfig = {
  configPath: string;
  mcpConfig: Record<string, unknown>;
};

export const saveMcpConfigRequest = async (
  servers: Record<string, unknown>,
  executor: BaseCodingAgent,
): Promise<SavedMcpConfig> => {
  const response = await desktopFetch<{
    config_path: string;
    mcp_config: Record<string, unknown>;
  }>(`/rpc/mcp-config?executor=${executor}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ servers, executor }),
  });

  return {
    configPath: response.config_path,
    mcpConfig: response.mcp_config,
  };
};
