import type { BaseCodingAgent } from "./executor-client";

export const EXECUTOR_INSTALL_GUIDE_URLS: Record<BaseCodingAgent, string> = {
  CLAUDE_CODE: "https://docs.anthropic.com/en/docs/claude-code/overview",
  CODEX: "https://developers.openai.com/codex",
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
