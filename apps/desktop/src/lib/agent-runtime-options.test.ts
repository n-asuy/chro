import { describe, expect, it } from "vitest";
import {
  getAllModelOptions,
  getModelLabel,
  getModelOptions,
  getModelReasoningOptions,
  getModelSpeedOptions,
  getReasoningLabel,
  retainSupportedOverrides,
} from "./agent-runtime-options";

const values = (options: { value: string }[]) => options.map((o) => o.value);

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
    expect(values(getModelSpeedOptions("CLAUDE_CODE", "opus"))).toEqual([
      "standard",
      "fast",
    ]);
    expect(getModelSpeedOptions("CLAUDE_CODE", "sonnet")).toEqual([]);
    expect(getModelSpeedOptions("CLAUDE_CODE", "fable")).toEqual([]);
    expect(getModelSpeedOptions("CODEX", "gpt-5.6-terra")).toEqual([]);
  });

  it("exposes effort up to max for every Claude model and its default", () => {
    for (const model of ["fable", "opus", "sonnet", "haiku", null]) {
      expect(values(getModelReasoningOptions("CLAUDE_CODE", model))).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
    expect(getModelReasoningOptions("PI", null)).toEqual([]);
  });

  it("exposes ultra only on the Codex models whose catalog lists it", () => {
    expect(values(getModelReasoningOptions("CODEX", "gpt-6.1-sol"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(values(getModelReasoningOptions("CODEX", "gpt-6-luna"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // Before a model is chosen, offer only what every Codex model supports.
    expect(values(getModelReasoningOptions("CODEX", null))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("labels effort values with the names the CLIs use on the wire", () => {
    expect(getReasoningLabel("xhigh")).toBe("Extra High");
    expect(getReasoningLabel("max")).toBe("Max");
    expect(getReasoningLabel("ultra")).toBe("Ultra");
  });

  it("lists Codex models in the Codex catalog order", () => {
    expect(values(getModelOptions("CODEX"))).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(getModelLabel("CODEX", "gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(getModelSpeedOptions("CODEX", "gpt-6.1-sol")).toEqual([]);
  });

  it("labels each Claude alias with the model it currently resolves to", () => {
    expect(getModelOptions("CLAUDE_CODE").map((m) => m.label)).toEqual([
      "Fable 5.1",
      "Opus 5.5",
      "Sonnet 5.5",
      "Haiku 5.5",
    ]);
  });
});

describe("retainSupportedOverrides", () => {
  it("keeps effort and speed the new model supports", () => {
    expect(
      retainSupportedOverrides("CLAUDE_CODE", "opus", {
        reasoning_effort: "max",
        speed: "fast",
      }),
    ).toEqual({ reasoning_effort: "max", speed: "fast" });
  });

  it("drops effort and speed the new model does not support", () => {
    expect(
      retainSupportedOverrides("CODEX", "gpt-6-luna", {
        reasoning_effort: "ultra",
        speed: null,
      }),
    ).toEqual({ reasoning_effort: null, speed: null });
    expect(
      retainSupportedOverrides("CLAUDE_CODE", "sonnet", {
        reasoning_effort: "high",
        speed: "fast",
      }),
    ).toEqual({ reasoning_effort: "high", speed: null });
  });
});
