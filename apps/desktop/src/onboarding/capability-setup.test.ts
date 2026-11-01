import { describe, expect, it } from "vitest";
import { capabilityActions } from "./capability-setup";

describe("capabilityActions", () => {
  it("applies only what the person left checked", () => {
    expect(
      capabilityActions(
        { command: true, skill: true },
        { commandRegistersOnContinue: true, skillState: "not_installed" },
      ),
    ).toEqual(["register_command", "install_skill"]);
    expect(
      capabilityActions(
        { command: false, skill: false },
        { commandRegistersOnContinue: true, skillState: "not_installed" },
      ),
    ).toEqual([]);
  });

  it("does nothing that is already done", () => {
    expect(
      capabilityActions(
        { command: true, skill: true },
        { commandRegistersOnContinue: false, skillState: "installed" },
      ),
    ).toEqual([]);
  });

  it("updates an outdated skill but never forces past a conflict", () => {
    expect(
      capabilityActions(
        { command: false, skill: true },
        { commandRegistersOnContinue: false, skillState: "outdated" },
      ),
    ).toEqual(["install_skill"]);
    expect(
      capabilityActions(
        { command: false, skill: true },
        { commandRegistersOnContinue: false, skillState: "conflict" },
      ),
    ).toEqual([]);
  });

  it("skips the skill when its state is unknown or there is no agent to teach", () => {
    for (const skillState of ["unavailable", "no_agent"] as const) {
      expect(
        capabilityActions(
          { command: false, skill: true },
          { commandRegistersOnContinue: false, skillState },
        ),
      ).toEqual([]);
    }
  });
});
