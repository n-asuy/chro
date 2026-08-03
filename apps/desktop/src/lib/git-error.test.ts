import { describe, expect, it } from "vitest";

import type { TranslationFunction, TranslationKey } from "@/i18n";
import { resolveGitError } from "./git-error";

/**
 * Stand-in translator: echoes the key so assertions describe which message the
 * user would see, and interpolates the one parameter the git messages use.
 */
const t = ((key: TranslationKey, params?: Record<string, string | number>) =>
  params ? `${key}:${params.message}` : key) as TranslationFunction;

/**
 * Git failures reach the UI as opaque command output. Every integration verb
 * (push, pull, merge, rebase) funnels through this resolver so the user sees an
 * actionable sentence instead of a raw stderr dump, and never sees nothing at
 * all.
 */
describe("resolveGitError", () => {
  it("recognises a rejected push before the generic matchers", () => {
    const err = new Error(
      "git push failed: Updates were rejected because the remote contains work",
    );

    expect(resolveGitError(err, t, "gitPushFailed")).toBe(
      "gitPushRejectedDescription",
    );
  });

  it("maps a conflicting merge to the conflict message", () => {
    const err = new Error("CONFLICT (content): Merge conflict in src/lib.rs");

    expect(resolveGitError(err, t, "diffMergeErrorMessage")).toBe(
      "gitMergeConflict",
    );
  });

  it("reads a branch that is already contained as up to date, not as a failure", () => {
    const err = new Error(
      "nothing to merge: Cannot merge: task branch 'ch/landed' has no changes left to apply to base branch 'main'. Its commits are already contained in the base.",
    );

    expect(resolveGitError(err, t, "diffMergeErrorMessage")).toBe(
      "gitNothingToMerge",
    );
  });

  it("maps a half-finished rebase to the in-progress message", () => {
    const err = new Error("bad request: rebase in progress");

    expect(resolveGitError(err, t, "rebaseErrorMessage")).toBe(
      "gitRebaseInProgress",
    );
  });

  it("keeps unrecognised detail instead of discarding it", () => {
    const err = new Error("bad request: refusing to merge unrelated histories");

    expect(resolveGitError(err, t, "diffMergeErrorMessage")).toBe(
      "gitErrorWithDetails:refusing to merge unrelated histories",
    );
  });

  it("falls back to the caller's verb when the failure carries no message", () => {
    expect(resolveGitError(new Error(""), t, "rebaseErrorMessage")).toBe(
      "rebaseErrorMessage",
    );
    expect(resolveGitError("boom", t, "diffMergeErrorMessage")).toBe(
      "diffMergeErrorMessage",
    );
  });
});
