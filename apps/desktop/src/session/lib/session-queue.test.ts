import { describe, expect, it } from "vitest";
import type { SessionQueueItem } from "../types";
import {
  composerSubmitIntent,
  moveQueueItem,
  orderSessionQueue,
  pendingQueueOrder,
  queuedMessagePreview,
  rewriteQueuedText,
  splitQueuedMessage,
} from "./session-queue";

const item = (
  id: string,
  task_id: string,
  created_at: string,
  seq = 0,
): SessionQueueItem => ({
  id,
  task_id,
  prompt: `prompt ${id}`,
  seq,
  created_at,
});

describe("orderSessionQueue", () => {
  it("lists the session's waiting messages oldest first", () => {
    const queue = {
      b: item("b", "t1", "2026-10-25 01:00:00.200"),
      a: item("a", "t1", "2026-10-25 01:00:00.100"),
    };
    expect(orderSessionQueue(queue, "t1").map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("follows the queue's order over arrival order", () => {
    const queue = {
      a: item("a", "t1", "2026-10-25 01:00:00.100", 2),
      b: item("b", "t1", "2026-10-25 01:00:00.200", 1),
    };
    expect(orderSessionQueue(queue, "t1").map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("leaves out other sessions' messages", () => {
    const queue = {
      a: item("a", "t1", "2026-10-25 01:00:00.100"),
      x: item("x", "t2", "2026-10-25 01:00:00.000"),
    };
    expect(orderSessionQueue(queue, "t1").map((i) => i.id)).toEqual(["a"]);
  });

  it("is empty without a session", () => {
    expect(orderSessionQueue({}, null)).toEqual([]);
  });
});

describe("composerSubmitIntent", () => {
  it("sends to an idle session with nothing waiting", () => {
    expect(
      composerSubmitIntent({ taskId: "t1", turnInFlight: false, waiting: 0 }),
    ).toBe("send");
  });

  it("queues behind a running turn", () => {
    expect(
      composerSubmitIntent({ taskId: "t1", turnInFlight: true, waiting: 0 }),
    ).toBe("queue");
  });

  it("queues behind waiting messages so nothing jumps the line", () => {
    expect(
      composerSubmitIntent({ taskId: "t1", turnInFlight: false, waiting: 2 }),
    ).toBe("queue");
  });

  it("holds while a new session's first turn is still being created", () => {
    // No session exists yet, so there is no queue to join.
    expect(
      composerSubmitIntent({ taskId: null, turnInFlight: true, waiting: 0 }),
    ).toBe("hold");
  });

  it("sends the first message of a new session", () => {
    expect(
      composerSubmitIntent({ taskId: null, turnInFlight: false, waiting: 0 }),
    ).toBe("send");
  });
});

describe("queuedMessagePreview", () => {
  it("shows the written text, not the markup the composer adds", () => {
    const prompt = [
      '<context>\n<file path="src/a.ts" />\n</context>',
      '<skills_context>\n<skill id="s1" name="review" />\n</skills_context>',
      "![red.png](.chro-context/a.png)![blue.png](.chro-context/b.png)",
      "Describe the images",
    ].join("\n");
    expect(queuedMessagePreview(prompt)).toEqual({
      text: "Describe the images",
      images: 2,
      references: 1,
      skills: 1,
    });
  });

  it("is just the text for a plain message", () => {
    expect(queuedMessagePreview("Run the tests")).toEqual({
      text: "Run the tests",
      images: 0,
      references: 0,
      skills: 0,
    });
  });
});

describe("moveQueueItem", () => {
  it("moves a message down onto another's place", () => {
    expect(moveQueueItem(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
  });

  it("moves a message up onto another's place", () => {
    expect(moveQueueItem(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("keeps the order when the target is itself or unknown", () => {
    const ids = ["a", "b"];
    expect(moveQueueItem(ids, "a", "a")).toBe(ids);
    expect(moveQueueItem(ids, "a", "x")).toBe(ids);
    expect(moveQueueItem(ids, "x", "a")).toBe(ids);
  });
});

describe("queued message text", () => {
  const prompt = [
    '<context>\n<file path="src/a.ts" />\n</context>',
    "![red.png](.chro-context/a.png)",
    "Describe the image",
  ].join("\n");

  it("separates what was written from what travels with it", () => {
    expect(splitQueuedMessage(prompt).text).toBe("Describe the image");
  });

  it("rewrites the text and keeps the attachments", () => {
    const rewritten = rewriteQueuedText(prompt, "Describe it in one word");
    expect(rewritten).toBe(
      prompt.replace("Describe the image", "Describe it in one word"),
    );
    expect(queuedMessagePreview(rewritten)).toEqual({
      text: "Describe it in one word",
      images: 1,
      references: 1,
      skills: 0,
    });
  });

  it("adds text to a message that had only attachments", () => {
    const imageOnly = "![red.png](.chro-context/a.png)";
    expect(splitQueuedMessage(imageOnly).text).toBe("");
    expect(rewriteQueuedText(imageOnly, "What is this?")).toBe(
      `${imageOnly}\nWhat is this?`,
    );
  });

  it("edits the whole message when markup sits inside the text", () => {
    const mixed = "Compare ![a.png](x/a.png) with the spec";
    expect(splitQueuedMessage(mixed)).toEqual({ prefix: "", text: mixed });
    expect(rewriteQueuedText(mixed, "Just the spec")).toBe("Just the spec");
  });
});

describe("pendingQueueOrder", () => {
  const items = [
    item("a", "t1", "2026-10-25 01:00:00.100", 1),
    item("b", "t1", "2026-10-25 01:00:00.200", 2),
  ];

  it("holds a dropped order until the stream shows it", () => {
    expect(pendingQueueOrder(items, ["b", "a"])).toEqual(["b", "a"]);
  });

  it("lets go once the stream confirms it", () => {
    expect(pendingQueueOrder(items, ["a", "b"])).toBeNull();
  });

  it("lets go when the queue changed under it", () => {
    expect(pendingQueueOrder(items.slice(0, 1), ["b", "a"])).toBeNull();
    expect(pendingQueueOrder(items, null)).toBeNull();
  });
});
