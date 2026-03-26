import { describe, expect, it } from "vitest";
import {
  parseSessionDragPayload,
  serializeSessionDragPayload,
} from "../utils/session-dnd";

describe("session-dnd", () => {
  it("round-trips a valid session payload", () => {
    const value = serializeSessionDragPayload({
      taskId: "bd7a332a-897c-4f4c-9f4b-b477c9bcf808",
      branch: "feature/auth",
    });

    expect(parseSessionDragPayload(value)).toEqual({
      taskId: "bd7a332a-897c-4f4c-9f4b-b477c9bcf808",
      branch: "feature/auth",
    });
  });

  it("normalizes non-string branches to null", () => {
    expect(
      parseSessionDragPayload(
        JSON.stringify({
          taskId: "bd7a332a-897c-4f4c-9f4b-b477c9bcf808",
          branch: 123,
        }),
      ),
    ).toEqual({
      taskId: "bd7a332a-897c-4f4c-9f4b-b477c9bcf808",
      branch: null,
    });
  });

  it("rejects invalid payloads", () => {
    expect(parseSessionDragPayload(null)).toBeNull();
    expect(parseSessionDragPayload("")).toBeNull();
    expect(parseSessionDragPayload("{")).toBeNull();
    expect(
      parseSessionDragPayload(JSON.stringify({ branch: "main" })),
    ).toBeNull();
  });
});
