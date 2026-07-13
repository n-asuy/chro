import { runtimePlatform } from "@/workspace-layout/lib/open-in";

export type FeedbackCategory = "feedback" | "bug" | "feature";

export interface FeedbackSubmission {
  category: FeedbackCategory;
  message: string;
}

/**
 * Base URL of the cloud API (`apps/api`, a Cloudflare Worker) that persists
 * feedback and forwards it to Slack. Bound to the worker's custom domain.
 */
const CLOUD_API_BASE = "https://api.chro-ai.com";

const resolveAppVersion = (): string | undefined => {
  if (import.meta.env.VITE_APP_VERSION) {
    return import.meta.env.VITE_APP_VERSION;
  }
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : undefined;
};

export async function submitFeedback(
  submission: FeedbackSubmission,
): Promise<void> {
  const response = await fetch(`${CLOUD_API_BASE}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: submission.category,
      message: submission.message,
      appVersion: resolveAppVersion(),
      platform: runtimePlatform(),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      body || `Feedback request failed with status ${response.status}`,
    );
  }
}
