/**
 * @vitest-environment jsdom
 */
import { LanguageProvider } from "@/i18n";
import {
  SessionDirectoryProvider,
  createSessionDirectory,
} from "@/session/context/session-directory-context";
import type { StoredTask } from "@/session/types";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserMessageContent } from "../../conversation-view";
import {
  getPromptEditorHandle,
  usePromptEditorStore,
} from "../../state/prompt-editor-store";
import { formatContextForPrompt } from "../../types/context";
import { PromptEditor } from "../prompt-editor/prompt-editor";
import {
  PreviewContext,
  type PreviewController,
} from "../session-preview-trigger";

/**
 * Hovering a session pill opens the shared session preview, the same panel a
 * session row or a session named in prose opens, below the pill.
 */
const TASK_ID = "79d441b9-33b0-4533-9439-41a23f5ec8b0";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const task: StoredTask = {
  id: TASK_ID,
  slug: "20CFfEXi",
  project_id: "project-1",
  title: "Claude Codeが重い理由",
  status: "completed",
  created_at: "2026-11-12T00:00:00Z",
  updated_at: "2026-11-12T00:00:00Z",
  sort_order: 0,
  last_executor: "CLAUDE_CODE",
};

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let controller: {
  [K in keyof PreviewController]: ReturnType<typeof vi.fn>;
};

function mount(children: ReactNode) {
  const directory = createSessionDirectory();
  directory.update([task], () => {});
  act(() => {
    root.render(
      <LanguageProvider>
        <SessionDirectoryProvider value={directory}>
          <PreviewContext.Provider
            value={controller as unknown as PreviewController}
          >
            {children}
          </PreviewContext.Provider>
        </SessionDirectoryProvider>
      </LanguageProvider>,
    );
  });
}

function pointer(
  type: "pointerover" | "pointerout" | "pointerdown",
  target: Element,
  relatedTarget: Element | null = null,
) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, relatedTarget }),
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  controller = {
    notifyEnter: vi.fn(),
    notifyLeave: vi.fn(),
    notifyDismiss: vi.fn(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  usePromptEditorStore.setState({ scopes: {} });
});

describe("session pill in a sent message", () => {
  const message = (taskId: string) =>
    `${formatContextForPrompt([{ kind: "session", taskId }])}\nこれを参考にして`;

  const pill = () =>
    container.querySelector<HTMLElement>("[data-session-reference]");

  it("opens the session preview below the pill on hover", () => {
    mount(<UserMessageContent content={message(TASK_ID)} />);

    pointer("pointerover", pill() as HTMLElement);
    expect(controller.notifyEnter).toHaveBeenCalledWith(task, pill(), "below");

    pointer("pointerout", pill() as HTMLElement, container);
    expect(controller.notifyLeave).toHaveBeenCalledTimes(1);
  });

  it("leaves the preview to the panel instead of a native tooltip", () => {
    mount(<UserMessageContent content={message(TASK_ID)} />);

    expect(pill()?.hasAttribute("title")).toBe(false);
  });

  it("has no preview for a session the app does not know", () => {
    mount(<UserMessageContent content={message(UNKNOWN_ID)} />);

    pointer("pointerover", pill() as HTMLElement);
    expect(controller.notifyEnter).not.toHaveBeenCalled();
  });
});

describe("session pill in the composer", () => {
  const editor = () =>
    container.querySelector<HTMLElement>('[data-prompt-editor-drop="true"]');
  const pill = () =>
    container.querySelector<HTMLElement>('[data-type="session"]');

  function mountComposer(taskId: string) {
    const handle = getPromptEditorHandle("tab:composer");
    mount(<PromptEditor handle={handle} onSubmit={() => {}} />);
    act(() => handle.addSessionPart(taskId, null, task.title));
  }

  it("opens the session preview below the pill on hover", () => {
    mountComposer(TASK_ID);

    pointer("pointerover", pill() as HTMLElement, editor());
    expect(controller.notifyEnter).toHaveBeenCalledWith(task, pill(), "below");

    pointer("pointerout", pill() as HTMLElement, editor());
    expect(controller.notifyLeave).toHaveBeenCalledTimes(1);
  });

  it("closes the preview when the pill is pressed", () => {
    mountComposer(TASK_ID);

    pointer("pointerover", pill() as HTMLElement, editor());
    pointer("pointerdown", pill() as HTMLElement);

    expect(controller.notifyDismiss).toHaveBeenCalledTimes(1);
  });

  it("ignores pointer movement over the typed text", () => {
    mountComposer(TASK_ID);

    pointer("pointerover", editor() as HTMLElement);
    pointer("pointerout", editor() as HTMLElement, container);

    expect(controller.notifyEnter).not.toHaveBeenCalled();
    expect(controller.notifyLeave).not.toHaveBeenCalled();
  });

  it("has no preview for a session the app does not know", () => {
    mountComposer(UNKNOWN_ID);

    pointer("pointerover", pill() as HTMLElement, editor());
    expect(controller.notifyEnter).not.toHaveBeenCalled();
  });
});
