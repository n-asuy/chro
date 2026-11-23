import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_ICON,
  TASK_ICON_NAMES,
  taskIcon,
  taskIconPath,
} from "./task-icons";

/** The names the server offers the titling model. */
function serverIconNames(): string[] {
  const source = readFileSync(
    resolve(__dirname, "../../../../../crates/executors/src/session_title.rs"),
    "utf8",
  );
  const list = source.match(
    /pub const TASK_ICONS: \[&str; \d+\] = \[([^\]]*)\]/,
  );
  if (!list) throw new Error("TASK_ICONS not found in session_title.rs");
  return [...list[1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
}

describe("session icons", () => {
  it("has 48 icons, each a single non-empty path", () => {
    expect(TASK_ICON_NAMES).toHaveLength(48);
    for (const name of TASK_ICON_NAMES) {
      expect(taskIconPath(name)).toMatch(/^M/);
    }
  });

  it("draws exactly the names the titling model is offered, in the same order", () => {
    expect(serverIconNames()).toEqual(TASK_ICON_NAMES);
  });

  it("uses a session's icon, and the neutral default for none or an unknown name", () => {
    expect(taskIcon("rocket")).toBe("rocket");
    expect(taskIcon(null)).toBe(DEFAULT_TASK_ICON);
    expect(taskIcon(undefined)).toBe(DEFAULT_TASK_ICON);
    expect(taskIcon("spaceship")).toBe(DEFAULT_TASK_ICON);
    expect(taskIcon("toString")).toBe(DEFAULT_TASK_ICON);
  });
});
