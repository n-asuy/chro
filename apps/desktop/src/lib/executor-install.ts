import type { BaseCodingAgent } from "./executor-client";
import { openExternalUrl } from "./open-external-url";

/**
 * Upstream install/sign-in documentation per agent.
 *
 * Chro does not install agent CLIs or drive their sign-in: each CLI owns that
 * flow, and doing it for them broke in ways we could not fix from here (a shim
 * we cannot spawn, an installer that rejects the host). We detect what is on
 * PATH and point at the CLI's own guide instead.
 */
export const EXECUTOR_INSTALL_GUIDE_URLS: Record<BaseCodingAgent, string> = {
  CLAUDE_CODE: "https://docs.anthropic.com/en/docs/claude-code/overview",
  CODEX: "https://developers.openai.com/codex",
  PI: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
};

export const openExecutorInstallGuide = (executor: BaseCodingAgent): void => {
  openExternalUrl(EXECUTOR_INSTALL_GUIDE_URLS[executor]);
};
