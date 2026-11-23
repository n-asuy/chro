import { useSessionReadStore } from "@/session/state/session-read-store";
import type { StoredTask } from "@/session/types";
import { beforeEach, describe, expect, it } from "vitest";
import { closedPresence, nextPresence } from "../domain/edge-motion";
import {
  type EdgeSession,
  deriveEdgeSessionState,
} from "../domain/edge-sessions";
import { useEdgeToolbarStore } from "./edge-toolbar-store";

function session(
  id: string,
  fields: Partial<StoredTask>,
  viewedAt?: string,
): EdgeSession {
  const task: StoredTask = {
    id,
    project_id: "p1",
    title: id,
    status: "completed",
    created_at: "2026-11-17T09:00:00.000Z",
    updated_at: "2026-11-17T10:00:00.000Z",
    sort_order: 0,
    ...fields,
  };
  const state = deriveEdgeSessionState(task, viewedAt);
  if (!state) throw new Error(`${id} has no edge state`);
  return { task, state };
}

const waiting = session("w", {
  status: "running",
  active_session_id: "s",
  awaiting_input: true,
});
const finished = session("done", {});
const existing = new Set(["w", "done"]);

const store = () => useEdgeToolbarStore.getState();

describe("Unread pager", () => {
  beforeEach(() => {
    useEdgeToolbarStore.setState({
      expanded: false,
      panel: null,
      help: false,
      preview: null,
      hint: false,
      moreOpen: false,
      unread: { order: [], cursorId: null, cursorIndex: 0, shown: [] },
    });
  });

  it("opens on the session waiting for an answer, ahead of finished ones", () => {
    store().openUnread();
    store().syncUnread([finished, waiting], existing);

    expect(store().unread.order).toEqual(["w", "done"]);
    expect(store().unread.cursorId).toBe("w");
  });

  it("keeps a finished session read on show until the pager closes, then drops it", () => {
    store().openUnread();
    store().syncUnread([finished, waiting], existing);
    store().stepUnread(1);
    expect(store().unread.cursorId).toBe("done");

    // Shown, so the session panel marked it read: it no longer needs the user.
    store().syncUnread([waiting], existing);
    expect(store().unread.order).toEqual(["w", "done"]);
    expect(store().unread.cursorId).toBe("done");

    store().closePanel();
    store().openUnread();
    store().syncUnread([waiting], existing);
    expect(store().unread.order).toEqual(["w"]);
  });

  it("J and K stop at the ends", () => {
    store().openUnread();
    store().syncUnread([finished, waiting], existing);

    store().stepUnread(-1);
    expect(store().unread.cursorId).toBe("w");
    store().stepUnread(1);
    store().stepUnread(1);
    expect(store().unread.cursorId).toBe("done");
  });

  it("lands on the next item when the shown one is archived", () => {
    store().openUnread();
    store().syncUnread([finished, waiting], existing);

    store().syncUnread([finished], new Set(["done"]));

    expect(store().unread.cursorId).toBe("done");
  });

  it("does not track the pager while a single session is open", () => {
    store().openSession("w");
    store().syncUnread([finished, waiting], existing);

    expect(store().unread.order).toEqual([]);
  });

  it("stays expanded while a panel is open", () => {
    store().openSession("w");
    store().collapse();
    expect(store().expanded).toBe(true);

    store().closePanel();
    store().collapse();
    expect(store().expanded).toBe(false);
  });

  it("toggles the keyboard help over the open panel and forgets it when the panel changes", () => {
    store().openUnread();
    store().toggleHelp();
    expect(store().help).toBe(true);
    store().toggleHelp();
    expect(store().help).toBe(false);

    store().toggleHelp();
    store().openSession("w");
    expect(store().help).toBe(false);

    store().toggleHelp();
    store().closePanel();
    store().openUnread();
    expect(store().help).toBe(false);
  });

  it("leaves a closed panel's pager and help as they were while its exit plays", () => {
    store().openUnread();
    store().syncUnread([finished, waiting], existing);
    store().toggleHelp();
    store().closePanel();

    expect(store().panel).toBeNull();
    expect(store().unread.order).toEqual(["w", "done"]);
    expect(store().help).toBe(true);

    // Syncing a closed pager changes nothing.
    store().syncUnread([], new Set());
    expect(store().unread.order).toEqual(["w", "done"]);
  });

  it("shows no help without a panel", () => {
    store().toggleHelp();
    expect(store().help).toBe(false);
  });

  it("opens Unread with the toolbar when the tab is clicked, as the mock's summon does", () => {
    store().summon();
    expect(store().expanded).toBe(true);
    expect(store().panel).toEqual({ kind: "unread" });
  });

  it("shows the tab's hint only while collapsed", () => {
    store().setHint(true);
    expect(store().hint).toBe(true);
    store().setHint(false);
    expect(store().hint).toBe(false);

    store().summon();
    store().setHint(true);
    expect(store().hint).toBe(false);
  });

  it("opens the session list from the capsule only when nothing else is open", () => {
    store().summon();
    store().openList();
    expect(store().panel).toEqual({ kind: "unread" });

    store().closePanel();
    store().openList();
    expect(store().panel).toEqual({ kind: "list" });
    expect(store().expanded).toBe(true);
  });

  it("previews a session only while the list is open, and forgets it on close", () => {
    store().previewSession("a");
    expect(store().preview).toBeNull();

    store().openList();
    store().previewSession("a");
    expect(store().preview).toBe("a");

    store().openSession("a");
    expect(store().preview).toBeNull();
    expect(store().panel).toEqual({ kind: "session", taskId: "a" });

    store().closePanel();
    store().openList();
    store().previewSession("b");
    store().closePanel();
    expect(store().preview).toBeNull();
  });

  it("opens the more menu only on the expanded toolbar and closes it with the toolbar", () => {
    store().setMoreOpen(true);
    expect(store().moreOpen).toBe(false);

    store().summon();
    store().setMoreOpen(true);
    expect(store().moreOpen).toBe(true);

    store().closePanel();
    store().collapse();
    expect(store().moreOpen).toBe(false);
  });

  it("keeps the more menu open while its usage panel is, and toggles that panel", () => {
    store().summon();
    store().closePanel();
    store().setMoreOpen(true);
    store().toggleUsage();
    expect(store().panel).toEqual({ kind: "usage" });

    store().setMoreOpen(false);
    expect(store().moreOpen).toBe(true);

    store().toggleUsage();
    expect(store().panel).toBeNull();
    store().setMoreOpen(false);
    expect(store().moreOpen).toBe(false);
  });
});

describe("talking", () => {
  beforeEach(() => {
    useEdgeToolbarStore.setState(useEdgeToolbarStore.getInitialState(), true);
  });

  it("brings the toolbar out and closes the open panel", () => {
    useEdgeToolbarStore.getState().openSession("t1");
    useEdgeToolbarStore
      .getState()
      .startTalking({ kind: "session", taskId: "t1" });
    const state = useEdgeToolbarStore.getState();
    expect(state.expanded).toBe(true);
    expect(state.panel).toBeNull();
    expect(state.talk).toEqual({
      phase: "starting",
      target: { kind: "session", taskId: "t1" },
    });
  });

  it("does not tuck the toolbar in while the talk pill shows", () => {
    useEdgeToolbarStore.getState().startTalking({ kind: "newChat" });
    useEdgeToolbarStore.getState().collapse();
    expect(useEdgeToolbarStore.getState().expanded).toBe(true);
    useEdgeToolbarStore.getState().setTalk({ phase: "idle" });
    useEdgeToolbarStore.getState().collapse();
    expect(useEdgeToolbarStore.getState().expanded).toBe(false);
  });
});

describe("stepping aside for chro's own window", () => {
  beforeEach(() => {
    useEdgeToolbarStore.setState(useEdgeToolbarStore.getInitialState(), true);
  });

  it("closes what is open and folds the toolbar", () => {
    const store = useEdgeToolbarStore.getState();
    store.openSession("t1");
    store.setMoreOpen(true);
    store.toggleHelp();
    store.setHidden(true);
    const state = useEdgeToolbarStore.getState();
    expect(state).toMatchObject({
      hidden: true,
      expanded: false,
      panel: null,
      help: false,
      moreOpen: false,
      preview: null,
      hint: false,
    });
  });

  it("stops talking without a send", () => {
    useEdgeToolbarStore.getState().startTalking({ kind: "newChat" });
    useEdgeToolbarStore.getState().setHidden(true);
    expect(useEdgeToolbarStore.getState().talk).toEqual({ phase: "idle" });
  });

  it("comes back as the collapsed tab", () => {
    const store = useEdgeToolbarStore.getState();
    store.openUnread();
    store.setHidden(true);
    store.setHidden(false);
    const state = useEdgeToolbarStore.getState();
    expect(state.hidden).toBe(false);
    expect(state.expanded).toBe(false);
    expect(state.panel).toBeNull();
  });
});

describe("the edge settings flyout", () => {
  beforeEach(() => {
    useEdgeToolbarStore.setState(useEdgeToolbarStore.getInitialState(), true);
  });

  it('opens beside the open "…" and keeps it open', () => {
    const store = useEdgeToolbarStore.getState();
    store.toggleSettings();
    expect(useEdgeToolbarStore.getState()).toMatchObject({
      expanded: true,
      panel: { kind: "settings" },
      moreOpen: true,
      settingsPage: null,
    });
    store.setMoreOpen(false);
    expect(useEdgeToolbarStore.getState().moreOpen).toBe(true);
  });

  it("shows a sub-page only while the settings are open", () => {
    const store = useEdgeToolbarStore.getState();
    store.setSettingsPage("look");
    expect(useEdgeToolbarStore.getState().settingsPage).toBeNull();
    store.toggleSettings();
    store.setSettingsPage("language");
    expect(useEdgeToolbarStore.getState().settingsPage).toBe("language");
  });

  it("closes with its sub-page", () => {
    const store = useEdgeToolbarStore.getState();
    store.toggleSettings();
    store.setSettingsPage("look");
    store.toggleSettings();
    expect(useEdgeToolbarStore.getState()).toMatchObject({
      panel: null,
      settingsPage: null,
    });
    store.toggleSettings();
    store.setSettingsPage("look");
    store.closePanel();
    expect(useEdgeToolbarStore.getState().settingsPage).toBeNull();
  });
});

describe("a capsule tile under the pointer", () => {
  beforeEach(() => {
    useEdgeToolbarStore.setState(useEdgeToolbarStore.getInitialState(), true);
    useSessionReadStore.setState({ viewedAt: {} });
  });
  const store = () => useEdgeToolbarStore.getState();

  it("previews that session beside the tile, on the expanded toolbar only", () => {
    store().peekSession("t1");
    expect(store().panel).toBeNull();
    store().expand();
    store().peekSession("t1");
    expect(store().panel).toEqual({ kind: "peek", taskId: "t1" });
  });

  it("swaps the previewed session in place from tile to tile (the frame does not re-open)", () => {
    store().expand();
    store().peekSession("t1");
    const shown = nextPresence(closedPresence, store().panel);
    store().peekSession("t2");
    expect(store().panel).toEqual({ kind: "peek", taskId: "t2" });
    // Same kind of panel: the presence is kept as is (no exit, no new open).
    expect(nextPresence(shown, store().panel)).toBe(shown);
  });

  it("replaces the session list, which the capsule's background opens", () => {
    store().expand();
    store().openList();
    store().peekSession("t1");
    expect(store().panel).toEqual({ kind: "peek", taskId: "t1" });
  });

  it("leaves a pinned panel alone", () => {
    store().expand();
    for (const pin of [
      () => store().openSession("t9"),
      () => store().openUnread(),
      () => store().toggleSettings(),
    ]) {
      store().closePanel();
      pin();
      const pinned = store().panel;
      store().peekSession("t1");
      expect(store().panel).toBe(pinned);
    }
  });

  it("pins the previewed session on a click (the session panel)", () => {
    store().expand();
    store().peekSession("t1");
    store().openSession("t1");
    expect(store().panel).toEqual({ kind: "session", taskId: "t1" });
    // Pinned: pointing at another tile no longer replaces it.
    store().peekSession("t2");
    expect(store().panel).toEqual({ kind: "session", taskId: "t1" });
  });

  it("closes when the pointer has left the tile and the card, and only the preview", () => {
    store().expand();
    store().peekSession("t1");
    store().endPeek();
    expect(store().panel).toBeNull();
    store().openSession("t2");
    store().endPeek();
    expect(store().panel).toEqual({ kind: "session", taskId: "t2" });
  });

  it("never marks the previewed session read", () => {
    store().expand();
    store().peekSession("t1");
    store().peekSession("t2");
    store().endPeek();
    expect(useSessionReadStore.getState().viewedAt).toEqual({});
  });

  it("does not open while the toolbar steps aside, and closes when it does", () => {
    store().expand();
    store().setHidden(true);
    store().peekSession("t1");
    expect(store().panel).toBeNull();
    store().setHidden(false);
    store().expand();
    store().peekSession("t1");
    store().setHidden(true);
    expect(store().panel).toBeNull();
  });
});

describe("the session icon picker", () => {
  beforeEach(() => {
    useEdgeToolbarStore.setState(useEdgeToolbarStore.getInitialState(), true);
  });
  const store = () => useEdgeToolbarStore.getState();

  it("toggles inside the open compact panel of that session only", () => {
    store().toggleIconPicker("t1");
    expect(store().iconPicker).toBeNull();
    store().openSession("t1");
    store().toggleIconPicker("t2");
    expect(store().iconPicker).toBeNull();
    store().toggleIconPicker("t1");
    expect(store().iconPicker).toBe("t1");
    store().toggleIconPicker("t1");
    expect(store().iconPicker).toBeNull();
  });

  it("toggles in Unread's card for the session it shows", () => {
    useEdgeToolbarStore.setState({
      panel: { kind: "unread" },
      unread: {
        order: ["t1", "t2"],
        cursorId: "t1",
        cursorIndex: 0,
        shown: ["t1"],
      },
    });
    store().toggleIconPicker("t2");
    expect(store().iconPicker).toBeNull();
    store().toggleIconPicker("t1");
    expect(store().iconPicker).toBe("t1");
  });

  it("opens from a row's context with the picker shown, and closes with the panel", () => {
    store().pickIcon("t4");
    expect(store().panel).toEqual({ kind: "session", taskId: "t4" });
    expect(store().iconPicker).toBe("t4");
    store().openSession("t5");
    expect(store().iconPicker).toBeNull();
    store().pickIcon("t5");
    store().closePanel();
    expect(store().iconPicker).toBeNull();
  });
});
