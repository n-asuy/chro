import { describe, expect, it } from "vitest";
import { resolveExecutorSettingLocks } from "../executor-setting-locks";

describe("resolveExecutorSettingLocks", () => {
  it("allows runtime and model selection before the first turn", () => {
    expect(
      resolveExecutorSettingLocks({ hasTaskRun: false, isSending: false }),
    ).toEqual({ runtimeLocked: false, modelLocked: false });
  });

  it("keeps the model editable between turns in an existing session", () => {
    expect(
      resolveExecutorSettingLocks({ hasTaskRun: true, isSending: false }),
    ).toEqual({ runtimeLocked: true, modelLocked: false });
  });

  it("locks both settings while a turn is running", () => {
    expect(
      resolveExecutorSettingLocks({ hasTaskRun: true, isSending: true }),
    ).toEqual({ runtimeLocked: true, modelLocked: true });
  });
});
