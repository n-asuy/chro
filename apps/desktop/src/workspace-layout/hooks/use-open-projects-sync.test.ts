import type { ProjectResponse } from "@/tasks/task-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenProjectsStore } from "../state/open-projects-store";
import { syncRouteProject } from "./use-open-projects-sync";

vi.mock("@/lib/ui-state-client", () => ({
  flushUiState: vi.fn(),
  getUiValue: () => null,
  isUiStateReady: () => true,
  setUiValue: vi.fn(),
}));

const repo: ProjectResponse = {
  id: "repo",
  slug: "repo",
  name: "Repo",
  gitRepoPath: "/work/repo",
  isGeneral: false,
  badgeColor: null,
};

const general: ProjectResponse = {
  id: "general",
  slug: "general",
  name: "General",
  gitRepoPath: "/data/chats",
  isGeneral: true,
  badgeColor: null,
};

const openIds = () => useOpenProjectsStore.getState().projects.map((p) => p.id);

beforeEach(() => {
  useOpenProjectsStore.setState({ projects: [], hydrated: true });
});

describe("syncRouteProject", () => {
  it("registers a routed repository as an open project", () => {
    syncRouteProject(repo);
    expect(openIds()).toEqual(["repo"]);
  });

  it("never registers the scratch project, so chats stay out of Projects", () => {
    syncRouteProject(general);
    expect(openIds()).toEqual([]);
  });

  it("evicts a scratch project persisted by an earlier build", () => {
    useOpenProjectsStore.setState({
      projects: [
        { id: "repo", slug: "repo", name: "Repo", workspacePath: "/work/repo" },
        {
          id: "general",
          slug: "general",
          name: "General",
          workspacePath: "/data/chats",
        },
      ],
    });
    syncRouteProject(general);
    expect(openIds()).toEqual(["repo"]);
  });
});
