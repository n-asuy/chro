export const WORKSPACE_REFRESH_EVENT = "chro:workspace-refresh";

export const dispatchWorkspaceRefreshEvent = () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WORKSPACE_REFRESH_EVENT));
};
