import { LanguageProvider } from "@/i18n";
import type { CliInstallStatus } from "@/lib/cli-install-client";
import type { useCliInstall } from "@/settings/hooks/use-cli-install";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChroCliInstallControl } from "./chro-cli-install-control";

type CliInstall = ReturnType<typeof useCliInstall>;

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

function cli(overrides: Partial<CliInstall>): CliInstall {
  return {
    available: true,
    status: status({}),
    loading: false,
    busy: false,
    error: null,
    reload: async () => {},
    install: async () => null,
    remove: async () => null,
    ...overrides,
  };
}

function render(value: CliInstall): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <ChroCliInstallControl cli={value} />
    </LanguageProvider>,
  );
}

describe("ChroCliInstallControl", () => {
  it("offers Install and no Remove when nothing is registered", () => {
    const html = render(
      cli({
        status: status({
          state: "not_installed",
          detail: "Register `chro` in /usr/local/bin.",
        }),
      }),
    );
    expect(html).toContain("Not registered");
    expect(html).toContain(">Install<");
    expect(html).not.toContain(">Remove<");
    expect(html).toContain("Register `chro` in /usr/local/bin.");
  });

  it("offers Remove only once registered and reachable", () => {
    const html = render(cli({}));
    expect(html).toContain("Registered");
    expect(html).toContain(">Remove<");
    expect(html).not.toContain(">Install<");
    expect(html).toContain("/usr/local/bin/chro");
  });

  it("offers Repair and Remove for a stale registration", () => {
    const html = render(cli({ status: status({ state: "stale" }) }));
    expect(html).toContain("Points at another chro build");
    expect(html).toContain(">Repair<");
    expect(html).toContain(">Remove<");
  });

  it("offers no actions on a conflict", () => {
    const html = render(cli({ status: status({ state: "conflict" }) }));
    expect(html).toContain("Blocked by another command");
    expect(html).not.toContain("<button");
  });

  it("shows the action error instead of the status detail", () => {
    const html = render(
      cli({
        status: status({ state: "not_installed", detail: "Register it." }),
        error: "Administrator authorization was cancelled.",
      }),
    );
    expect(html).toContain("Administrator authorization was cancelled.");
    expect(html).not.toContain("Register it.");
  });

  it("can hide the primary action when the host performs it", () => {
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <ChroCliInstallControl
          cli={cli({ status: status({ state: "not_installed" }) })}
          hidePrimaryAction
        />
      </LanguageProvider>,
    );
    expect(html).toContain("Not registered");
    expect(html).not.toContain(">Install<");
  });

  it("shows a checking state before the first probe answers", () => {
    const html = render(cli({ status: null, loading: true }));
    expect(html).toContain("Checking...");
    expect(html).not.toContain("<button");
  });
});
