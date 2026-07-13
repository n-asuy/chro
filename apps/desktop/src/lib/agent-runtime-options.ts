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

// `value` is passed to the Claude Code CLI via `--model`. The short aliases
// (`opus`/`sonnet`/`haiku`) are resolved by the CLI to the current model
// snapshot, so `label` carries the human-facing generation (Opus 4.8 /
// Sonnet 5 / Haiku 4.5) so the selector shows which model the alias points at.
// Fable 5 has no short alias, so it uses its pinned model id directly.
const CLAUDE_MODELS: ModelOption[] = [
  {
    value: "claude-fable-5",
    label: "Fable 5",
    description: "Most capable model for demanding, long-horizon work.",
  },
  {
    value: "opus",
    label: "Opus 4.8",
    description: "Highly capable model for complex agentic coding.",
  },
  {
    value: "sonnet",
    label: "Sonnet 5",
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
    value: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    description:
      "Frontier model tuned for detail and polish on complex coding and research.",
  },
  {
    value: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    description: "Everyday workhorse for general coding.",
  },
  {
    value: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    description: "Fast, efficient model for clear, repeatable work.",
  },
  {
    value: "gpt-5.5",
    label: "GPT-5.5",
    description: "Previous-generation frontier model for complex coding.",
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
  switch (executor) {
    case "CODEX":
      return CODEX_MODELS;
    case "CLAUDE_CODE":
      return CLAUDE_MODELS;
    // pi's model list is provider-dependent (resolved from its own
    // settings.json / `--provider`), so it has no static presets here; the
    // selector shows "Default" and pi uses its configured model.
    case "PI":
      return [];
  }
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
