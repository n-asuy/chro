import { describe, expect, it } from "vitest";
import {
  getAllModelOptions,
  getModelLabel,
  getModelOptions,
  getModelReasoningOptions,
  getModelSpeedOptions,
} from "./agent-runtime-options";

describe("agent-runtime-options capability axes", () => {
  it("returns a flat list where each model carries its runtime", () => {
    const all = getAllModelOptions();
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) {
      expect(["CLAUDE_CODE", "CODEX", "PI"]).toContain(m.executor);
    }
    // Both Claude and Codex models coexist in one list (model-first picker).
    expect(all.some((m) => m.executor === "CLAUDE_CODE")).toBe(true);
    expect(all.some((m) => m.executor === "CODEX")).toBe(true);
  });

  it("exposes speed only for Opus, not for other Claude models", () => {
    expect(
      getModelSpeedOptions("CLAUDE_CODE", "opus").map((s) => s.value),
    ).toEqual(["standard", "fast"]);
    expect(getModelSpeedOptions("CLAUDE_CODE", "sonnet")).toEqual([]);
    expect(getModelSpeedOptions("CLAUDE_CODE", "claude-fable-5-1")).toEqual([]);
    expect(getModelSpeedOptions("CODEX", "gpt-5.6-terra")).toEqual([]);
  });

  it("exposes effort for Codex models and its default, not for Claude", () => {
    expect(
      getModelReasoningOptions("CODEX", "gpt-5.6-terra").map((r) => r.value),
    ).toEqual(["low", "medium", "high", "x-high"]);
    // Codex keeps effort available even before a model is chosen.
    expect(getModelReasoningOptions("CODEX", null).length).toBe(4);
    // Claude has no effort axis in this phase.
    expect(getModelReasoningOptions("CLAUDE_CODE", "opus")).toEqual([]);
    expect(getModelReasoningOptions("CLAUDE_CODE", null)).toEqual([]);
    expect(getModelReasoningOptions("PI", null)).toEqual([]);
  });

  it("lists Codex models in the Codex catalog order", () => {
    expect(getModelOptions("CODEX").map((m) => m.value)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(getModelLabel("CODEX", "gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(
      getModelReasoningOptions("CODEX", "gpt-6.1-sol").map((r) => r.value),
    ).toEqual(["low", "medium", "high", "x-high"]);
    expect(getModelSpeedOptions("CODEX", "gpt-6.1-sol")).toEqual([]);
  });

  it("labels each Claude alias with the model it currently resolves to", () => {
    expect(getModelOptions("CLAUDE_CODE").map((m) => m.label)).toEqual([
      "Fable 5.1",
      "Opus 5.5",
      "Sonnet 5",
      "Haiku 4.5",
    ]);
  });
});
