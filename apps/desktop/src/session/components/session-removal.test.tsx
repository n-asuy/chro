/**
 * @vitest-environment jsdom
 */
import type { TranslationFunction } from "@/i18n";
import ja from "@/i18n/locales/ja";
import type { SessionDeletePlan } from "@/tasks/task-api";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const t: TranslationFunction = (key, replacements) =>
  Object.entries(replacements ?? {}).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    ja[key],
  );

const { taskApi, toast, closeSessionTabs } = vi.hoisted(() => ({
  taskApi: { deletePlan: vi.fn(), remove: vi.fn(), cancel: vi.fn() },
  toast: vi.fn(),
  closeSessionTabs: vi.fn(),
}));

vi.mock("@/i18n", () => ({ useLanguage: () => ({ t }) }));
vi.mock("@/tasks/task-api", () => ({ taskApi }));
vi.mock("@chro/ui/hooks/use-toast", () => ({ toast }));
vi.mock("@/workspace-layout/state/layout-store", () => ({
  useLayoutStore: { getState: () => ({ closeSessionTabs }) },
}));

import {
  type SessionRemoval,
  SessionRemovalProvider,
  describeSessionDelete,
  useSessionRemoval,
} from "./session-removal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const plan = (
  overrides: Partial<SessionDeletePlan> = {},
): SessionDeletePlan => ({
  branch: "ch/943c-task",
  worktrees: ["/worktrees/ch/943c-task"],
  uncommitted_files: 0,
  ...overrides,
});

describe("describeSessionDelete", () => {
  it("names the worktree and the kept branch", () => {
    expect(describeSessionDelete(plan(), t)).toBe(
      "会話と worktree を削除します。ブランチは残ります。この操作は取り消せません。",
    );
  });

  it("counts the uncommitted files lost with the worktree", () => {
    expect(describeSessionDelete(plan({ uncommitted_files: 4 }), t)).toBe(
      "会話と worktree を削除します。未コミットの変更（4 ファイル）も失われます。ブランチは残ります。この操作は取り消せません。",
    );
  });

  it("says so when the worktree's changes could not be read", () => {
    expect(describeSessionDelete(plan({ uncommitted_files: null }), t)).toBe(
      "会話と worktree を削除します。未コミットの変更があるか確認できませんでした。ブランチは残ります。この操作は取り消せません。",
    );
  });

  it("leaves a worktree another session uses out of what is removed", () => {
    expect(describeSessionDelete(plan({ worktrees: [] }), t)).toBe(
      "会話を削除します。ブランチは残ります。この操作は取り消せません。",
    );
  });

  it("does not mention a branch a chat never had", () => {
    expect(
      describeSessionDelete(plan({ branch: null, worktrees: [] }), t),
    ).toBe("会話を削除します。この操作は取り消せません。");
  });
});

describe("deleting a session", () => {
  const session = { id: "task-1", slug: "fix-login", title: "Fix login" };
  let container: HTMLDivElement;
  let root: Root;
  let removal: SessionRemoval;

  function Probe() {
    removal = useSessionRemoval();
    return null;
  }

  const deferred = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  const deleteButton = () =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === ja.delete,
    );

  async function confirmDelete() {
    await act(async () => removal.remove(session));
    await act(async () => deleteButton()?.click());
  }

  beforeEach(() => {
    vi.clearAllMocks();
    taskApi.deletePlan.mockResolvedValue(plan());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <SessionRemovalProvider>
          <Probe />
        </SessionRemovalProvider>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("closes the dialog and hides the session while the delete runs", async () => {
    const request = deferred();
    taskApi.remove.mockReturnValue(request.promise);

    await confirmDelete();

    expect(taskApi.remove).toHaveBeenCalledWith("task-1");
    expect(deleteButton()).toBeUndefined();
    expect(removal.isDeleting("task-1")).toBe(true);
    expect(closeSessionTabs).toHaveBeenCalledWith(["task-1", "fix-login"]);
    expect(toast).not.toHaveBeenCalled();

    await act(async () => request.resolve());

    expect(toast).toHaveBeenCalledWith({
      title: "「Fix login」を削除しました",
    });
    expect(removal.isDeleting("task-1")).toBe(true);
  });

  it("brings the session back and says why when the delete fails", async () => {
    const request = deferred();
    taskApi.remove.mockReturnValue(request.promise);

    await confirmDelete();
    await act(async () => request.reject(new Error("run did not stop")));

    expect(removal.isDeleting("task-1")).toBe(false);
    expect(toast).toHaveBeenCalledWith({
      variant: "destructive",
      title: "「Fix login」を削除できませんでした",
      description: "run did not stop",
    });
  });
});
