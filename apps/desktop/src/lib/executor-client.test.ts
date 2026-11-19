import { describe, expect, it } from "vitest";
import { parseLaunchArgsRejection } from "./executor-client";

describe("parseLaunchArgsRejection", () => {
  it("reads a reserved-flag refusal with its flag", () => {
    const body = JSON.stringify({
      error: { code: "reserved_flag", message: "…", flag: "--model" },
    });
    expect(parseLaunchArgsRejection(body)).toEqual({
      code: "reserved_flag",
      flag: "--model",
    });
  });

  it("reads a question-tool flag refusal", () => {
    const body = JSON.stringify({
      error: { code: "question_tool_flag", message: "…" },
    });
    expect(parseLaunchArgsRejection(body)).toEqual({
      code: "question_tool_flag",
    });
  });

  it("reads an unparseable refusal", () => {
    const body = JSON.stringify({
      error: { code: "unparseable", message: "…" },
    });
    expect(parseLaunchArgsRejection(body)).toEqual({ code: "unparseable" });
  });

  it("ignores other failures", () => {
    expect(parseLaunchArgsRejection("Internal Server Error")).toBeNull();
    expect(
      parseLaunchArgsRejection(JSON.stringify({ error: { code: "other" } })),
    ).toBeNull();
    expect(
      parseLaunchArgsRejection(
        JSON.stringify({ error: { code: "reserved_flag" } }),
      ),
    ).toBeNull();
  });
});
