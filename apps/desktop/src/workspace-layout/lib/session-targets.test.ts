import { describe, expect, it } from "vitest";
import type { PaneNode, Tab } from "../types";
import { listSessionTargets } from "./session-targets";

const tab = (id: string, kind: Tab["kind"], title = id): Tab => ({
  id,
  kind,
  title,
});

const root: PaneNode = {
  type: "split",
  id: "s",
  direction: "h",
  sizes: [50, 50],
  children: [
    {
      type: "leaf",
      id: "left",
      activeTabId: "a",
      tabs: [
        tab("a", { type: "session", taskId: "t1" }, "Pricing fixes"),
        tab("f", { type: "file", path: "site/index.html" }),
      ],
    },
    {
      type: "leaf",
      id: "right",
      activeTabId: "b",
      tabs: [tab("b", { type: "session", taskId: "t2" }, "Checkout")],
    },
  ],
};

describe("listSessionTargets", () => {
  it("lists every session tab with the leaf that holds it", () => {
    expect(listSessionTargets(root, null, (t) => t.title)).toEqual([
      { tabId: "a", leafId: "left", title: "Pricing fixes" },
      { tabId: "b", leafId: "right", title: "Checkout" },
    ]);
  });

  it("puts the session whose composer was used last first", () => {
    expect(
      listSessionTargets(root, "tab:b", (t) => t.title).map((t) => t.tabId),
    ).toEqual(["b", "a"]);
  });

  it("ignores a last-used composer that is not a tab in this layout", () => {
    expect(
      listSessionTargets(root, "route:p:new:latest", (t) => t.title).map(
        (t) => t.tabId,
      ),
    ).toEqual(["a", "b"]);
  });
});
