import type { BaseCodingAgent, ReasoningEffort } from "./executor-client";

/**
 * Source of truth for the Runtime / Model / Reasoning choices shown in the
 * `@` command palette. Runtime values mirror the Rust `BaseCodingAgent` enum;
 * model ids are passed verbatim to the executor (`--model` for Claude Code,
 * Codex `ThreadStartParams.model`); reasoning values mirror the Rust
 * `ReasoningEffort` enum and only apply to Codex.
 */

export type ModelOption = {
  value: string;
  label: string;
  description?: string;
};
export type ReasoningOption = { value: ReasoningEffort; label: string };

/** Label shown for the current value when no explicit override is selected. */
export const RUNTIME_DEFAULT_LABEL = "Default";

// `value` is the Claude Code CLI `--model` alias and must stay stable; the CLI
// resolves each alias to the current model snapshot. `label` carries the
// human-facing version (Opus 4.8 / Sonnet 4.6 / Haiku 4.5) so the selector
// shows which generation the alias points at.
const CLAUDE_MODELS: ModelOption[] = [
  {
    value: "opus",
    label: "Opus 4.8",
    description: "Most capable model for complex work.",
  },
  {
    value: "sonnet",
    label: "Sonnet 4.6",
    description: "Balanced model for everyday coding.",
  },
  {
    value: "haiku",
    label: "Haiku 4.5",
    description: "Fastest, most cost-efficient model.",
  },
];

const CODEX_MODELS: ModelOption[] = [
  {
    value: "gpt-5.5",
    label: "GPT-5.5",
    description:
      "Frontier model for complex coding, research, and real-world work.",
  },
  {
    value: "gpt-5.4",
    label: "GPT-5.4",
    description: "Strong model for everyday coding.",
  },
  {
    value: "gpt-5.4-mini",
    label: "GPT-5.4-Mini",
    description:
      "Small, fast, and cost-efficient model for simpler coding tasks.",
  },
  {
    value: "gpt-5.3-codex-spark",
    label: "GPT-5.3-Codex-Spark",
    description: "Ultra-fast coding model.",
  },
];

export const REASONING_OPTIONS: ReasoningOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "x-high", label: "Extra High" },
];

/** Available models for the given runtime. */
export function getModelOptions(executor: BaseCodingAgent): ModelOption[] {
  return executor === "CODEX" ? CODEX_MODELS : CLAUDE_MODELS;
}

/** Display label for a selected model value, or null when unset. */
export function getModelLabel(
  executor: BaseCodingAgent,
  modelValue: string | null | undefined,
): string | null {
  if (!modelValue) return null;
  const found = getModelOptions(executor).find((m) => m.value === modelValue);
  return found?.label ?? modelValue;
}

/** Display label for a selected reasoning effort, or null when unset. */
export function getReasoningLabel(
  value: ReasoningEffort | null | undefined,
): string | null {
  if (!value) return null;
  return REASONING_OPTIONS.find((r) => r.value === value)?.label ?? value;
}

/** Reasoning effort is a Codex-only concept. */
export function runtimeSupportsReasoning(executor: BaseCodingAgent): boolean {
  return executor === "CODEX";
}
