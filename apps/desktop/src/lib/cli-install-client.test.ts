import { describe, expect, it } from "vitest";
import {
  type CliInstallStatus,
  cliInstallAttention,
  cliInstallCanRemove,
  cliInstallNeedsAttention,
  cliInstallPrimaryAction,
  cliInstallRegistersOnContinue,
} from "./cli-install-client";

function status(overrides: Partial<CliInstallStatus>): CliInstallStatus {
  return {
    platform: "darwin",
    commandName: "chro",
    commandPath: "/usr/local/bin/chro",
    pathDirectory: "/usr/local/bin",
    pathConfigured: true,
    needsElevation: false,
    launcherPath: "/Applications/Chro.app/Contents/MacOS/chro",
    installMethod: "symlink",
    supported: true,
    state: "installed",
    currentTarget: "/Applications/Chro.app/Contents/MacOS/chro",
    detail: null,
    ...overrides,
  };
}

describe("cliInstallAttention", () => {
  it("is ready only when installed and reachable from a new terminal", () => {
    expect(cliInstallAttention(status({}))).toBe("ready");
    expect(cliInstallAttention(status({ pathConfigured: false }))).toBe(
      "needs_path",
    );
  });

  it("maps each registration state to one next step", () => {
    expect(cliInstallAttention(status({ state: "not_installed" }))).toBe(
      "needs_install",
    );
    expect(cliInstallAttention(status({ state: "stale" }))).toBe(
      "needs_repair",
    );
    expect(cliInstallAttention(status({ state: "conflict" }))).toBe("blocked");
    expect(cliInstallAttention(status({ state: "unsupported" }))).toBe(
      "unsupported",
    );
  });

  it("treats an unsupported build as unsupported regardless of state", () => {
    expect(
      cliInstallAttention(status({ supported: false, state: "installed" })),
    ).toBe("unsupported");
  });
});

describe("cliInstallNeedsAttention", () => {
  it("flags everything except ready and unsupported", () => {
    expect(cliInstallNeedsAttention(status({}))).toBe(false);
    expect(cliInstallNeedsAttention(status({ supported: false }))).toBe(false);
    expect(cliInstallNeedsAttention(status({ state: "not_installed" }))).toBe(
      true,
    );
    expect(cliInstallNeedsAttention(status({ pathConfigured: false }))).toBe(
      true,
    );
    expect(cliInstallNeedsAttention(status({ state: "conflict" }))).toBe(true);
  });
});

describe("primary action and remove", () => {
  it("offers install, repair, or nothing", () => {
    expect(cliInstallPrimaryAction(status({ state: "not_installed" }))).toBe(
      "install",
    );
    expect(cliInstallPrimaryAction(status({ state: "stale" }))).toBe("repair");
    expect(cliInstallPrimaryAction(status({}))).toBeNull();
    expect(cliInstallPrimaryAction(status({ state: "conflict" }))).toBeNull();
    expect(cliInstallPrimaryAction(status({ supported: false }))).toBeNull();
  });

  it("only removes commands chro owns", () => {
    expect(cliInstallCanRemove(status({}))).toBe(true);
    expect(cliInstallCanRemove(status({ state: "stale" }))).toBe(true);
    expect(cliInstallCanRemove(status({ state: "not_installed" }))).toBe(false);
    expect(cliInstallCanRemove(status({ state: "conflict" }))).toBe(false);
    expect(cliInstallCanRemove(status({ supported: false }))).toBe(false);
  });
});

describe("cliInstallRegistersOnContinue", () => {
  it("registers silently only when there is work and no prompt", () => {
    expect(cliInstallRegistersOnContinue(status({ state: "not_installed" }))).toBe(
      true,
    );
    expect(cliInstallRegistersOnContinue(status({ state: "stale" }))).toBe(true);
    expect(
      cliInstallRegistersOnContinue(
        status({ state: "not_installed", needsElevation: true }),
      ),
    ).toBe(false);
    expect(cliInstallRegistersOnContinue(status({}))).toBe(false);
    expect(cliInstallRegistersOnContinue(status({ state: "conflict" }))).toBe(
      false,
    );
    expect(cliInstallRegistersOnContinue(status({ supported: false }))).toBe(
      false,
    );
  });
});
