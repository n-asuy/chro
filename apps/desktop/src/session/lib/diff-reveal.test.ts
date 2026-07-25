import { describe, expect, it } from "vitest";

import { type DiffRevealRequest, resolveDiffReveal } from "./diff-reveal";

const request = (
  overrides: Partial<DiffRevealRequest> = {},
): DiffRevealRequest => ({
  path: "src/app.ts",
  taskRunId: "run-1",
  token: 1,
  ...overrides,
});

describe("resolveDiffReveal", () => {
  it("returns null when there is no pending request", () => {
    expect(
      resolveDiffReveal({
        request: null,
        scopeTaskRunId: "run-1",
        paths: ["src/app.ts"],
        handledToken: 0,
      }),
    ).toBeNull();
  });

  it("resolves the diff path when scope and path match", () => {
    expect(
      resolveDiffReveal({
        request: request(),
        scopeTaskRunId: "run-1",
        paths: ["src/other.ts", "src/app.ts"],
        handledToken: 0,
      }),
    ).toEqual({ path: "src/app.ts", token: 1 });
  });

  it("compares paths regardless of a leading slash on either side", () => {
    expect(
      resolveDiffReveal({
        request: request({ path: "/src/app.ts" }),
        scopeTaskRunId: "run-1",
        paths: ["src/app.ts"],
        handledToken: 0,
      }),
    ).toEqual({ path: "src/app.ts", token: 1 });

    expect(
      resolveDiffReveal({
        request: request({ path: "src/app.ts" }),
        scopeTaskRunId: "run-1",
        paths: ["/src/app.ts"],
        handledToken: 0,
      }),
    ).toEqual({ path: "/src/app.ts", token: 1 });
  });

  it("returns null once the token has been handled, so unrelated renders do not re-scroll", () => {
    expect(
      resolveDiffReveal({
        request: request({ token: 3 }),
        scopeTaskRunId: "run-1",
        paths: ["src/app.ts"],
        handledToken: 3,
      }),
    ).toBeNull();
  });

  it("re-resolves the same path when the token is bumped again", () => {
    expect(
      resolveDiffReveal({
        request: request({ token: 4 }),
        scopeTaskRunId: "run-1",
        paths: ["src/app.ts"],
        handledToken: 3,
      }),
    ).toEqual({ path: "src/app.ts", token: 4 });
  });

  it("ignores requests aimed at another run's diff", () => {
    expect(
      resolveDiffReveal({
        request: request({ taskRunId: "run-2" }),
        scopeTaskRunId: "run-1",
        paths: ["src/app.ts"],
        handledToken: 0,
      }),
    ).toBeNull();
  });

  it("keeps the run diff and the project diff apart", () => {
    // Project-scoped request must not move a run diff...
    expect(
      resolveDiffReveal({
        request: request({ taskRunId: null }),
        scopeTaskRunId: "run-1",
        paths: ["src/app.ts"],
        handledToken: 0,
      }),
    ).toBeNull();

    // ...and a run-scoped request must not move the project diff.
    expect(
      resolveDiffReveal({
        request: request({ taskRunId: "run-1" }),
        scopeTaskRunId: null,
        paths: ["src/app.ts"],
        handledToken: 0,
      }),
    ).toBeNull();

    // Both unscoped: the project working diff answers.
    expect(
      resolveDiffReveal({
        request: request({ taskRunId: null }),
        scopeTaskRunId: null,
        paths: ["src/app.ts"],
        handledToken: 0,
      }),
    ).toEqual({ path: "src/app.ts", token: 1 });
  });

  it("treats undefined scope as the project working diff", () => {
    expect(
      resolveDiffReveal({
        request: request({ taskRunId: null }),
        scopeTaskRunId: undefined,
        paths: ["src/app.ts"],
        handledToken: 0,
      }),
    ).toEqual({ path: "src/app.ts", token: 1 });
  });

  it("stays pending while the requested file has not streamed in yet", () => {
    // The tab opens before its diffs arrive; the request must survive that
    // render so the effect can resolve it once the file shows up.
    expect(
      resolveDiffReveal({
        request: request(),
        scopeTaskRunId: "run-1",
        paths: [],
        handledToken: 0,
      }),
    ).toBeNull();

    expect(
      resolveDiffReveal({
        request: request(),
        scopeTaskRunId: "run-1",
        paths: ["src/app.ts"],
        handledToken: 0,
      }),
    ).toEqual({ path: "src/app.ts", token: 1 });
  });
});
