/**
 * @vitest-environment jsdom
 */
import { LanguageProvider } from "@/i18n";
import type { CliStatus } from "@/lib/cli-status-client";
import {
  type AgentLaunchArgs,
  type AgentLaunchSettings,
  type BaseCodingAgent,
  LaunchArgsRejectedError,
} from "@/lib/executor-client";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentList, type AgentListProps } from "./agent-list";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CLAUDE: CliStatus = {
  name: "claude",
  found: true,
  path: "/Users/me/.local/bin/claude",
  source: "path",
  version: "2.3.1",
  install_hint: "npm install -g @anthropic-ai/claude-code",
};
const CODEX: CliStatus = {
  name: "codex",
  found: true,
  path: "/opt/homebrew/bin/codex",
  source: "path",
  version: "0.98.0",
  install_hint: "npm install -g @openai/codex",
};
const PI_MISSING: CliStatus = {
  name: "pi",
  found: false,
  path: null,
  source: null,
  version: null,
  install_hint: "npm install -g @earendil-works/pi-coding-agent",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function props(overrides: Partial<AgentListProps> = {}): AgentListProps {
  return {
    statuses: [CLAUDE, CODEX, PI_MISSING],
    loading: false,
    loadError: false,
    onReload: vi.fn(),
    defaultExecutor: "CLAUDE_CODE",
    defaultSaving: false,
    onSetDefault: vi.fn(),
    launchSettings: launchSettings(),
    onUpdateLaunchSettings: vi.fn(async () => {}),
    ...overrides,
  };
}

function launchSettings(
  launch_args: AgentLaunchArgs = {},
  question_tool_disabled: BaseCodingAgent[] = [],
): AgentLaunchSettings {
  return {
    launch_args,
    question_tool_agents: ["CLAUDE_CODE"],
    question_tool_disabled,
  };
}

function render(value: AgentListProps) {
  act(() => {
    root.render(
      <LanguageProvider>
        <AgentList {...value} />
      </LanguageProvider>,
    );
  });
}

function row(executor: BaseCodingAgent): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-agent="${executor}"]`,
  );
  if (!element) throw new Error(`no row for ${executor}`);
  return element;
}

function argsInput(executor: BaseCodingAgent): HTMLInputElement | null {
  return row(executor).querySelector<HTMLInputElement>(
    "input[data-field='launch-args']",
  );
}

function button(scope: HTMLElement, name: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name,
  );
  if (!match) throw new Error(`no button "${name}"`);
  return match;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(input: HTMLInputElement, name: string) {
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true }),
    );
  });
}

async function blur(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

describe("AgentList", () => {
  it("lists detected agents with their executable and the missing ones apart", () => {
    render(props());
    const claude = row("CLAUDE_CODE");
    expect(claude.textContent).toContain("Claude Code");
    expect(claude.textContent).toContain("claude");
    expect(
      container.querySelector("[data-section='installed']")?.textContent,
    ).toContain("Codex");
    const missing = container.querySelector("[data-section='missing']");
    expect(missing?.textContent).toContain("pi");
    expect(missing?.textContent).toContain(PI_MISSING.install_hint);
    expect(argsInput("PI")).toBeNull();
  });

  it("marks the default agent and sets another as default", () => {
    const onSetDefault = vi.fn();
    render(props({ onSetDefault }));
    expect(row("CLAUDE_CODE").textContent).toContain("Default");
    act(() => button(row("CODEX"), "Set default").click());
    expect(onSetDefault).toHaveBeenCalledWith("CODEX");
  });

  it("opens rows that carry launch arguments and shows them in the summary", () => {
    const launchArgs: AgentLaunchArgs = {
      CLAUDE_CODE: '--append-system-prompt "Ask first."',
    };
    render(props({ launchSettings: launchSettings(launchArgs) }));
    expect(argsInput("CLAUDE_CODE")?.value).toBe(
      '--append-system-prompt "Ask first."',
    );
    expect(row("CLAUDE_CODE").textContent).toContain(CLAUDE.path);
    expect(row("CLAUDE_CODE").textContent).toContain("2.3.1");
    expect(argsInput("CODEX")).toBeNull();

    act(() => button(row("CODEX"), "Show launch settings").click());
    expect(argsInput("CODEX")?.value).toBe("");
  });

  it("saves trimmed arguments on blur and on Enter, but not when unchanged", async () => {
    const onSaveLaunchArgs = vi.fn(async () => {});
    render(
      props({
        onUpdateLaunchSettings: onSaveLaunchArgs,
        launchSettings: launchSettings({ CLAUDE_CODE: "--a" }),
      }),
    );
    const input = argsInput("CLAUDE_CODE") as HTMLInputElement;

    await blur(input);
    expect(onSaveLaunchArgs).not.toHaveBeenCalled();

    type(input, "  --b  ");
    await blur(input);
    expect(onSaveLaunchArgs).toHaveBeenLastCalledWith("CLAUDE_CODE", {
      args: "--b",
    });

    type(input, "--c");
    await act(async () => key(input, "Enter"));
    expect(onSaveLaunchArgs).toHaveBeenLastCalledWith("CLAUDE_CODE", {
      args: "--c",
    });
  });

  it("reverts the draft on Escape without saving", () => {
    const onSaveLaunchArgs = vi.fn(async () => {});
    render(
      props({
        onUpdateLaunchSettings: onSaveLaunchArgs,
        launchSettings: launchSettings({ CLAUDE_CODE: "--a" }),
      }),
    );
    const input = argsInput("CLAUDE_CODE") as HTMLInputElement;
    type(input, "--changed");
    key(input, "Escape");
    expect(input.value).toBe("--a");
    expect(onSaveLaunchArgs).not.toHaveBeenCalled();
  });

  it("offers Reset only when arguments are set, and Reset clears them", async () => {
    const onSaveLaunchArgs = vi.fn(async () => {});
    render(
      props({
        onUpdateLaunchSettings: onSaveLaunchArgs,
        launchSettings: launchSettings({ CLAUDE_CODE: "--a" }),
      }),
    );
    await act(async () => button(row("CLAUDE_CODE"), "Reset").click());
    expect(onSaveLaunchArgs).toHaveBeenCalledWith("CLAUDE_CODE", { args: "" });

    act(() => button(row("CODEX"), "Show launch settings").click());
    expect(() => button(row("CODEX"), "Reset")).toThrow();
  });

  it("explains a refused flag and keeps the draft for correction", async () => {
    const onSaveLaunchArgs = vi.fn(async () => {
      throw new LaunchArgsRejectedError({
        code: "reserved_flag",
        flag: "--model",
      });
    });
    render(
      props({
        onUpdateLaunchSettings: onSaveLaunchArgs,
        launchSettings: launchSettings({ CLAUDE_CODE: "--a" }),
      }),
    );
    const input = argsInput("CLAUDE_CODE") as HTMLInputElement;
    type(input, "--model opus");
    await blur(input);

    expect(input.value).toBe("--model opus");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(row("CLAUDE_CODE").textContent).toContain("--model");
    expect(row("CLAUDE_CODE").querySelector("[role='alert']")).not.toBeNull();

    key(input, "Escape");
    expect(input.value).toBe("--a");
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  it("offers the question tool switch only for agents that have one", () => {
    render(props());
    act(() => button(row("CLAUDE_CODE"), "Show launch settings").click());
    act(() => button(row("CODEX"), "Show launch settings").click());
    const claudeSwitch = row("CLAUDE_CODE").querySelector("[role='switch']");
    expect(claudeSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(row("CODEX").querySelector("[role='switch']")).toBeNull();
  });

  it("turns the question tool off and keeps such rows open", async () => {
    const onUpdateLaunchSettings = vi.fn(async () => {});
    render(props({ onUpdateLaunchSettings }));
    act(() => button(row("CLAUDE_CODE"), "Show launch settings").click());
    const toggle =
      row("CLAUDE_CODE").querySelector<HTMLButtonElement>("[role='switch']");
    await act(async () => toggle?.click());
    expect(onUpdateLaunchSettings).toHaveBeenCalledWith("CLAUDE_CODE", {
      question_tool: false,
    });

    act(() => root.unmount());
    root = createRoot(container);
    render(props({ launchSettings: launchSettings({}, ["CLAUDE_CODE"]) }));
    const off = row("CLAUDE_CODE").querySelector("[role='switch']");
    expect(off?.getAttribute("aria-checked")).toBe("false");
  });

  it("points a question-tool flag in the arguments to the switch", async () => {
    const onUpdateLaunchSettings = vi.fn(async () => {
      throw new LaunchArgsRejectedError({ code: "question_tool_flag" });
    });
    render(
      props({
        onUpdateLaunchSettings,
        launchSettings: launchSettings({ CLAUDE_CODE: "--a" }),
      }),
    );
    const input = argsInput("CLAUDE_CODE") as HTMLInputElement;
    type(input, "--disallowedTools AskUserQuestion");
    await blur(input);
    expect(row("CLAUDE_CODE").textContent).toContain("Ask questions");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
});
