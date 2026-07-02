import type { BaseCodingAgent, InstallableTool } from "./executor-client";
import { desktopFetch } from "./backend-client";

export const EXECUTOR_INSTALL_GUIDE_URLS: Record<BaseCodingAgent, string> = {
  CLAUDE_CODE: "https://docs.anthropic.com/en/docs/claude-code/overview",
  CODEX: "https://developers.openai.com/codex",
  PI: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
};

export const openExecutorInstallGuide = async (
  executor: BaseCodingAgent,
): Promise<void> => {
  const url = EXECUTOR_INSTALL_GUIDE_URLS[executor];
  const openExternal = window.desktop?.openExternalUrl;

  if (openExternal) {
    await openExternal(url);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
};

export const installTool = async (
  tool: InstallableTool,
): Promise<{ ok: boolean }> => {
  // Electron path: only for executor agents, not Git
  if (tool !== "GIT") {
    const installExecutor = window.desktop?.installExecutor;
    if (installExecutor) {
      return installExecutor(tool);
    }
  }

  return desktopFetch<{ ok: boolean }>("/rpc/executor/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool }),
  });
};
