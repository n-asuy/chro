import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createInitialLayout } from "../lib/pane-tree";
import { useLayoutStore } from "../state/layout-store";
import {
  type ProjectNavigation,
  useProjectNavigation,
} from "./use-project-navigation";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../lib/persistence", () => ({
  loadLayout: () => null,
  saveLayout: vi.fn(),
}));
vi.mock("@/lib/workspace-history", () => ({ touchRecentWorkspace: vi.fn() }));

const project = {
  id: "project-b",
  slug: "beta",
  name: "Beta",
  workspacePath: "/repo/b",
};
let navigation: ProjectNavigation;
function Capture() {
  navigation = useProjectNavigation();
  return null;
}

beforeEach(() => {
  navigate.mockClear();
  useLayoutStore.setState({
    projectId: "project-a",
    layout: createInitialLayout(),
    closeFocusTargets: {},
  });
  renderToStaticMarkup(<Capture />);
});

describe("project-owned Map navigation", () => {
  it("carries a file to the destination without opening it in the outgoing project", () => {
    const outgoing = useLayoutStore.getState().layout;
    navigation.openProjectFile(project, "docs/AGENTS.md");
    expect(useLayoutStore.getState().layout).toBe(outgoing);
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/files",
      params: { projectId: "beta" },
      state: {
        projectTab: {
          projectId: "project-b",
          kind: { type: "file", path: "docs/AGENTS.md" },
        },
      },
    });
  });

  it.each(["docs", ""])(
    "carries directory %j across the project switch",
    (homeDir) => {
      navigation.newSession(project, homeDir);
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          state: {
            projectTab: {
              projectId: "project-b",
              kind: { type: "session", homeDir },
            },
          },
        }),
      );
      expect(useLayoutStore.getState().projectId).toBe("project-a");
    },
  );

  it("opens a writable relative file immediately in the bound project", () => {
    useLayoutStore.setState({ projectId: "project-b" });
    navigation.openProjectFile(project, "docs/AGENTS.md");
    const root = useLayoutStore.getState().layout.root;
    expect(root.type).toBe("leaf");
    if (root.type === "leaf") {
      expect(
        root.tabs.find((tab) => tab.id === root.activeTabId)?.kind,
      ).toEqual({ type: "file", path: "docs/AGENTS.md" });
    }
    expect(navigate).not.toHaveBeenCalled();
  });
});
