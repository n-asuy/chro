import type {
  SearchMatchType,
  ProjectSearchResult,
} from "@/lib/project-client";

export type FileSearchResult = ProjectSearchResult & {
  name: string;
  normalizedPath: string;
};

const normalizeResultPath = (path: string): string => {
  if (!path) return "/";
  const cleaned = path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return cleaned ? `/${cleaned}` : "/";
};

export const MATCH_TYPE_LABELS: Record<SearchMatchType, string> = {
  FileName: "name",
  DirectoryName: "dir",
  ContentMatch: "content",
  FullPath: "path",
};

export const enrichProjectResults = (
  results: ProjectSearchResult[],
): FileSearchResult[] => {
  return results.map((result) => {
    const name = result.path.split("/").pop() || result.path;
    return {
      ...result,
      name,
      normalizedPath: normalizeResultPath(result.path),
    };
  });
};
