import type { ProjectResponse } from "@/tasks/task-api";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ALL_PROJECTS_QUERY_KEY, rememberProject } from "./use-all-projects";

const project = (id: string, name: string): ProjectResponse => ({
  id,
  slug: id,
  name,
  gitRepoPath: `/work/${id}`,
  isGeneral: false,
  badgeColor: null,
});

describe("rememberProject", () => {
  it("adds a project missing from a cached list fetched before it existed", () => {
    const client = new QueryClient();
    client.setQueryData(ALL_PROJECTS_QUERY_KEY, [project("repo", "Repo")]);
    const general = { ...project("general", "General"), isGeneral: true };

    rememberProject(client, general);

    expect(
      client.getQueryData<ProjectResponse[]>(ALL_PROJECTS_QUERY_KEY),
    ).toEqual([project("repo", "Repo"), general]);
  });

  it("replaces the cached entry for an existing project", () => {
    const client = new QueryClient();
    client.setQueryData(ALL_PROJECTS_QUERY_KEY, [project("repo", "Old")]);

    rememberProject(client, project("repo", "New"));

    expect(
      client.getQueryData<ProjectResponse[]>(ALL_PROJECTS_QUERY_KEY),
    ).toEqual([project("repo", "New")]);
  });

  it("leaves an unfetched list alone so the first fetch stays authoritative", () => {
    const client = new QueryClient();

    rememberProject(client, project("repo", "Repo"));

    expect(client.getQueryData(ALL_PROJECTS_QUERY_KEY)).toBeUndefined();
  });
});
