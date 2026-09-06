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

  it("offers GPT-6 Astra first among the Codex models", () => {
    const codex = getModelOptions("CODEX");
    expect(codex[0]?.value).toBe("gpt-6-astra");
    expect(getModelLabel("CODEX", "gpt-6-astra")).toBe("GPT-6 Astra");
    expect(
      getModelReasoningOptions("CODEX", "gpt-6-astra").map((r) => r.value),
    ).toEqual(["low", "medium", "high", "x-high"]);
    expect(getModelSpeedOptions("CODEX", "gpt-6-astra")).toEqual([]);
  });
});
