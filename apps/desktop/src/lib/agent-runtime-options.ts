import type {
  BaseCodingAgent,
  ReasoningEffort,
  SpeedMode,
} from "./executor-client";

/**
 * Source of truth for the Model / Effort / Speed choices shown in the runtime
 * selector and the `@` command palette.
 *
 * The picker is model-first: each {@link ModelOption} is self-contained and
 * carries the `executor` it runs on, so selecting a model sets the runtime too
 * (there is no separate "pick the CLI first" step). Effort and Speed are
 * per-model capability axes: an option only advertises the levels the model
 * actually supports, and a model that supports neither hides those rows.
 *
 * Model ids are passed verbatim to the executor (`--model` for Claude Code,
 * Codex `ThreadStartParams.model`); reasoning values mirror the Rust
 * `ReasoningEffort` enum; speed values mirror the Rust `SpeedMode` enum.
 */

export type ModelOption = {
  value: string;
  label: string;
  /** Runtime this model runs on. Selecting the model selects the runtime. */
  executor: BaseCodingAgent;
  description?: string;
  /** Reasoning-effort levels this model supports; absent hides the Effort row. */
  effortLevels?: ReasoningEffort[];
  /** Output-speed modes this model supports; absent hides the Speed row. */
  speedModes?: SpeedMode[];
};
export type ReasoningOption = { value: ReasoningEffort; label: string };
export type SpeedOption = {
  value: SpeedMode;
  label: string;
  description?: string;
};

/** Label shown for the current value when no explicit override is selected. */
export const RUNTIME_DEFAULT_LABEL = "Default";

// Codex exposes four reasoning levels; a Codex model advertises this set.
const CODEX_EFFORT_LEVELS: ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "x-high",
];

// `value` is passed to the Claude Code CLI via `--model`. The short aliases
// (`opus`/`sonnet`/`haiku`) are resolved by the CLI to the current model
// snapshot, so `label` carries the human-facing generation (Opus 5 /
// Sonnet 5 / Haiku 4.5) so the selector shows which model the alias points at.
// Fable 5 has no short alias, so it uses its pinned model id directly.
const CLAUDE_MODELS: ModelOption[] = [
  {
    value: "claude-fable-5",
    label: "Fable 5",
    executor: "CLAUDE_CODE",
    description: "Most capable model for demanding, long-horizon work.",
  },
  {
    value: "opus",
    label: "Opus 5",
    executor: "CLAUDE_CODE",
    description: "Highly capable model for complex agentic coding.",
    // Fast mode is Opus-only; other Claude models have no speed toggle.
    speedModes: ["standard", "fast"],
  },
  {
    value: "sonnet",
    label: "Sonnet 5",
    executor: "CLAUDE_CODE",
    description: "Balanced model for everyday coding.",
  },
  {
    value: "haiku",
    label: "Haiku 4.5",
    executor: "CLAUDE_CODE",
    description: "Fastest, most cost-efficient model.",
  },
];

const CODEX_MODELS: ModelOption[] = [
  {
    value: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    executor: "CODEX",
    description:
      "Frontier model tuned for detail and polish on complex coding and research.",
    effortLevels: CODEX_EFFORT_LEVELS,
  },
  {
    value: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    executor: "CODEX",
    description: "Everyday workhorse for general coding.",
    effortLevels: CODEX_EFFORT_LEVELS,
  },
  {
    value: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    executor: "CODEX",
    description: "Fast, efficient model for clear, repeatable work.",
    effortLevels: CODEX_EFFORT_LEVELS,
  },
  {
    value: "gpt-5.5",
    label: "GPT-5.5",
    executor: "CODEX",
    description: "Previous-generation frontier model for complex coding.",
    effortLevels: CODEX_EFFORT_LEVELS,
  },
  {
    value: "gpt-5.3-codex-spark",
    label: "GPT-5.3-Codex-Spark",
    executor: "CODEX",
    description: "Ultra-fast coding model.",
    effortLevels: CODEX_EFFORT_LEVELS,
  },
];

export const REASONING_OPTIONS: ReasoningOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "x-high", label: "Extra High" },
];

export const SPEED_OPTIONS: SpeedOption[] = [
  { value: "standard", label: "Standard", description: "Default speed" },
  { value: "fast", label: "Fast", description: "Faster output, more usage" },
];

/** Static model presets for the given runtime (empty for provider-driven pi). */
export function getModelOptions(executor: BaseCodingAgent): ModelOption[] {
  switch (executor) {
    case "CODEX":
      return CODEX_MODELS;
    case "CLAUDE_CODE":
      return CLAUDE_MODELS;
    // pi's model list is provider-dependent (resolved from its own
    // settings.json / `--provider`), so it has no static presets here; the
    // selector fetches them and shows "Default" until they load.
    case "PI":
      return [];
  }
}

/**
 * Every static model across runtimes, as one flat list for a model-first
 * picker. pi models are provider-driven and fetched separately, so they are
 * not included here.
 */
export function getAllModelOptions(): ModelOption[] {
  return [...CLAUDE_MODELS, ...CODEX_MODELS];
}

/** Look up a static model option by runtime + value. */
export function findModelOption(
  executor: BaseCodingAgent,
  modelValue: string | null | undefined,
): ModelOption | null {
  if (!modelValue) return null;
  return getModelOptions(executor).find((m) => m.value === modelValue) ?? null;
}

/** Display label for a selected model value, or null when unset. */
export function getModelLabel(
  executor: BaseCodingAgent,
  modelValue: string | null | undefined,
): string | null {
  if (!modelValue) return null;
  return findModelOption(executor, modelValue)?.label ?? modelValue;
}

/** Display label for a selected reasoning effort, or null when unset. */
export function getReasoningLabel(
  value: ReasoningEffort | null | undefined,
): string | null {
  if (!value) return null;
  return REASONING_OPTIONS.find((r) => r.value === value)?.label ?? value;
}

/** Display label for a selected speed mode, or null when unset/standard. */
export function getSpeedLabel(
  value: SpeedMode | null | undefined,
): string | null {
  if (!value) return null;
  return SPEED_OPTIONS.find((s) => s.value === value)?.label ?? value;
}

/** Effort levels a runtime exposes when no specific model is selected yet. */
function executorDefaultEffortLevels(
  executor: BaseCodingAgent,
): ReasoningEffort[] {
  // Codex always exposes reasoning effort, even on its default model; other
  // runtimes have no runtime-wide default effort control.
  return executor === "CODEX" ? CODEX_EFFORT_LEVELS : [];
}

/** Reasoning options a model supports, or [] when it has no effort control. */
export function getModelReasoningOptions(
  executor: BaseCodingAgent,
  modelValue: string | null | undefined,
): ReasoningOption[] {
  const levels = modelValue
    ? findModelOption(executor, modelValue)?.effortLevels ?? []
    : executorDefaultEffortLevels(executor);
  return REASONING_OPTIONS.filter((o) => levels.includes(o.value));
}

/** Speed options a model supports, or [] when it has no speed control. */
export function getModelSpeedOptions(
  executor: BaseCodingAgent,
  modelValue: string | null | undefined,
): SpeedOption[] {
  const modes = findModelOption(executor, modelValue)?.speedModes;
  if (!modes) return [];
  return SPEED_OPTIONS.filter((o) => modes.includes(o.value));
}
