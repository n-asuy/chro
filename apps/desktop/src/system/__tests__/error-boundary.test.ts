import { describe, expect, it } from "vitest";
import { describeError } from "../error-boundary";

describe("describeError", () => {
  it("extracts message and stack from an Error", () => {
    const error = new Error("boom");
    const result = describeError(error);
    expect(result.message).toBe("boom");
    expect(result.stack).toBe(error.stack);
  });

  it("falls back to the error name when the message is empty", () => {
    const error = new Error("");
    error.name = "RangeError";
    expect(describeError(error).message).toBe("RangeError");
  });

  it("returns a plain string error as-is, without a stack", () => {
    const result = describeError("Maximum update depth exceeded");
    expect(result).toEqual({ message: "Maximum update depth exceeded" });
  });

  it("handles null/undefined/empty without throwing", () => {
    expect(describeError(null).message).toBe("Unknown error");
    expect(describeError(undefined).message).toBe("Unknown error");
    expect(describeError("").message).toBe("Unknown error");
  });
});
