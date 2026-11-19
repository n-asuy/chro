import { describe, expect, it } from "vitest";
import {
  TALK_IDLE,
  type TalkState,
  beginTalk,
  cancelTalk,
  endTalk,
  hear,
  nextChunks,
  optionAction,
  talkStarted,
  talkTarget,
  transcriptSegments,
} from "./talk";

const session = { kind: "session", taskId: "t1" } as const;
const listening = (text: string): TalkState => ({
  phase: "listening",
  text,
  target: session,
});

describe("talkTarget", () => {
  it("is the session whose compact panel is open", () => {
    expect(talkTarget({ kind: "session", taskId: "t1" }, "t9")).toEqual(
      session,
    );
  });

  it("is the session the Unread pager shows", () => {
    expect(talkTarget({ kind: "unread" }, "t9")).toEqual({
      kind: "session",
      taskId: "t9",
    });
  });

  it("is a new chat when no card is open", () => {
    expect(talkTarget(null, "t9")).toEqual({ kind: "newChat" });
    expect(talkTarget({ kind: "list" }, null)).toEqual({ kind: "newChat" });
    expect(talkTarget({ kind: "usage" }, null)).toEqual({ kind: "newChat" });
    expect(talkTarget({ kind: "unread" }, null)).toEqual({ kind: "newChat" });
  });
});

describe("talking", () => {
  it("starts, listens, hears revisions and sends what was heard", () => {
    let state = beginTalk(TALK_IDLE, session);
    expect(state).toEqual({ phase: "starting", target: session });
    state = talkStarted(state, { outcome: "started" });
    state = hear(state, "make the");
    state = hear(state, "make the orders page faster");
    expect(endTalk(state)).toEqual({
      next: TALK_IDLE,
      send: { text: "make the orders page faster", target: session },
    });
  });

  it("sends the recognizer's final result over the last partial", () => {
    expect(
      endTalk(listening("make the orders"), "make the orders page faster"),
    ).toEqual({
      next: TALK_IDLE,
      send: { text: "make the orders page faster", target: session },
    });
    expect(endTalk(listening("make it so"), "  ").send?.text).toBe(
      "make it so",
    );
  });

  it("sends what the final result heard even when no partial arrived", () => {
    expect(endTalk(listening(""), "テストです").send?.text).toBe("テストです");
  });

  it("sends nothing when nothing was heard", () => {
    expect(endTalk(listening("   "))).toEqual({ next: TALK_IDLE, send: null });
  });

  it("ending before the microphone is on just closes", () => {
    expect(endTalk(beginTalk(TALK_IDLE, session))).toEqual({
      next: TALK_IDLE,
      send: null,
    });
  });

  it("does not restart while talking", () => {
    const state = listening("hi");
    expect(beginTalk(state, { kind: "newChat" })).toBe(state);
  });

  it("shows a note when a permission is off or the system cannot listen", () => {
    const starting = beginTalk(TALK_IDLE, session);
    expect(
      talkStarted(starting, { outcome: "blocked", privacy: "microphone" }),
    ).toEqual({
      phase: "notice",
      notice: { kind: "blocked", privacy: "microphone" },
    });
    expect(
      talkStarted(starting, { outcome: "unavailable", reason: "no model" }),
    ).toEqual({
      phase: "notice",
      notice: { kind: "unavailable", reason: "no model" },
    });
  });

  it("a start the shell cancelled leaves the pill closed", () => {
    expect(
      talkStarted(beginTalk(TALK_IDLE, session), { outcome: "cancelled" }),
    ).toBe(TALK_IDLE);
  });

  it("ignores words once not listening", () => {
    expect(hear(TALK_IDLE, "late")).toBe(TALK_IDLE);
  });

  it("Esc cancels without sending", () => {
    expect(cancelTalk(listening("never mind"))).toBe(TALK_IDLE);
  });
});

describe("optionAction", () => {
  it("holding starts talking and releasing ends it", () => {
    expect(optionAction("holdStart", TALK_IDLE)).toBe("startTalk");
    expect(optionAction("holdEnd", listening("hi"))).toBe("endTalk");
  });

  it("a tap while listening sends; Option twice while listening sends too", () => {
    expect(optionAction("send", listening("hi"))).toBe("endTalk");
    expect(optionAction("summon", listening("hi"))).toBe("endTalk");
  });

  it("Option twice summons when not talking", () => {
    expect(optionAction("summon", TALK_IDLE)).toBe("summon");
  });

  it("a hold while already talking does nothing", () => {
    expect(optionAction("holdStart", listening("hi"))).toBe("none");
    expect(optionAction("holdEnd", TALK_IDLE)).toBe("none");
  });
});

describe("transcriptSegments", () => {
  it("keeps what was shown and fades in the rest", () => {
    expect(transcriptSegments("make the", "make the page")).toEqual({
      kept: "make the",
      added: " page",
    });
  });

  it("splits Japanese by characters", () => {
    expect(transcriptSegments("注文ページ", "注文ページを速く")).toEqual({
      kept: "注文ページ",
      added: "を速く",
    });
  });

  it("re-fades from where a revision differs", () => {
    expect(transcriptSegments("make the paid", "make the page")).toEqual({
      kept: "make the pa",
      added: "ge",
    });
  });
});

describe("nextChunks", () => {
  it("adds new words as one chunk and keeps the rest", () => {
    const first = nextChunks([], "make the");
    expect(first).toEqual([{ key: 0, text: "make the" }]);
    const second = nextChunks(first, "make the page");
    expect(second).toEqual([
      { key: 0, text: "make the" },
      { key: 1, text: " page" },
    ]);
    expect(second[0]).toBe(first[0]);
  });

  it("cuts a revised chunk and fades in the replacement", () => {
    const chunks = [
      { key: 0, text: "注文" },
      { key: 1, text: "ページが" },
    ];
    expect(nextChunks(chunks, "注文ページを速く")).toEqual([
      { key: 0, text: "注文" },
      { key: 1, text: "ページ" },
      { key: 2, text: "を速く" },
    ]);
  });

  it("clears when the transcript is empty", () => {
    expect(nextChunks([{ key: 0, text: "a" }], "")).toEqual([]);
  });
});
