import type { ExecutorProfileId } from "@/lib/executor-client";

/**
 * The executor profile a run was started with, from its stored
 * `executor_label`. A follow-up sends it back so the session keeps the runtime
 * and model it was running with. `null` for a missing or unreadable label.
 */
export const parseExecutorProfileId = (
  value: string | null | undefined,
): ExecutorProfileId | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as ExecutorProfileId;
    if (!parsed || !parsed.executor) return null;
    return {
      executor: parsed.executor,
      variant: parsed.variant ?? null,
      model: parsed.model ?? null,
      reasoning_effort: parsed.reasoning_effort ?? null,
    };
  } catch (error) {
    console.warn("[session] Failed to parse executor profile", error);
    return null;
  }
};
