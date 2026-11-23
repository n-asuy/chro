import type { TranslationKey } from "@/i18n";
import { create } from "zustand";
import { desktopFetch } from "./backend-client";
import { useFeatureFlagStore, useFlag } from "./feature-flags-store";

interface CloudStatus {
  configured: boolean;
  signed_in: boolean;
  busy: boolean;
  email: string | null;
  sign_in_url: string | null;
  error: SignInErrorCode | null;
}
type SignInErrorCode =
  | "not_configured"
  | "unreachable"
  | "cancelled"
  | "timed_out"
  | "not_allowed"
  | "failed";
interface CloudAccessState {
  configured: boolean | null;
  signedIn: boolean;
  busy: boolean;
  signingOut: boolean;
  email: string | null;
  signInUrl: string | null;
  error: TranslationKey | null;
  refresh: () => Promise<void>;
  signIn: () => Promise<void>;
  cancel: () => Promise<void>;
  signOut: () => Promise<void>;
}
const errors: Record<SignInErrorCode, TranslationKey> = {
  not_configured: "cloudUnavailable",
  unreachable: "cloudSignInUnreachable",
  cancelled: "cloudSignInCancelled",
  timed_out: "cloudSignInTimeout",
  not_allowed: "cloudAccountRefused",
  failed: "cloudSignInFailed",
};
let revision = 0;
let poll: ReturnType<typeof setTimeout> | undefined;
function stopPolling() {
  clearTimeout(poll);
}

export const useCloudAccessStore = create<CloudAccessState>((set, get) => ({
  configured: null,
  signedIn: false,
  busy: false,
  signingOut: false,
  email: null,
  signInUrl: null,
  error: null,
  refresh: async () => {
    const current = revision;
    try {
      const status = await desktopFetch<CloudStatus>("/rpc/cloud/status");
      if (current !== revision) return;
      set({
        configured: status.configured,
        signedIn: status.signed_in,
        busy: status.busy,
        email: status.email,
        signInUrl: status.sign_in_url,
        error: status.error ? errors[status.error] : null,
      });
      useFeatureFlagStore
        .getState()
        .setBetaEnabled("cloud_sessions", status.signed_in);
      stopPolling();
      if (status.busy) poll = setTimeout(() => void get().refresh(), 750);
    } catch {
      if (current !== revision) return;
      set({ signedIn: false, busy: false, error: "cloudSignInUnreachable" });
      useFeatureFlagStore.getState().setBetaEnabled("cloud_sessions", false);
    }
  },
  signIn: async () => {
    if (get().busy || !get().configured) return;
    const current = ++revision;
    stopPolling();
    set({ busy: true, signedIn: false, email: null, error: null });
    useFeatureFlagStore.getState().setBetaEnabled("cloud_sessions", false);
    const started = await desktopFetch("/rpc/cloud/login", {
      method: "POST",
    }).then(
      () => true,
      () => false,
    );
    if (current !== revision) return;
    // The status says how the attempt is going, or why it could not start.
    await get().refresh();
    if (!started && !get().error) set({ error: "cloudSignInFailed" });
  },
  cancel: async () => {
    // Keep the attempt busy until the server confirms cancellation, so a retry
    // cannot race a still-running transfer and save an old account's token.
    revision++;
    stopPolling();
    try {
      await desktopFetch("/rpc/cloud/cancel", { method: "POST" });
      set({ busy: false, signInUrl: null, error: "cloudSignInCancelled" });
    } catch {
      set({ error: "cloudSignInUnreachable" });
    }
  },
  signOut: async () => {
    revision++;
    stopPolling();
    set({ signingOut: true, error: null });
    try {
      await desktopFetch("/rpc/cloud/logout", { method: "POST" });
      set({
        signedIn: false,
        signingOut: false,
        busy: false,
        email: null,
        signInUrl: null,
      });
      useFeatureFlagStore.getState().setBetaEnabled("cloud_sessions", false);
    } catch {
      set({ signingOut: false, error: "cloudSignInUnreachable" });
    }
  },
}));

/** Access is required even when a developer forces the local feature flag. */
export function useCloudSessions(): boolean {
  const enabled = useFlag("cloud_sessions");
  const signedIn = useCloudAccessStore((state) => state.signedIn);
  return enabled && signedIn;
}
