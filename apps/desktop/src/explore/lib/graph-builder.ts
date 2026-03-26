import { parseFrontmatter } from "@/files/lib/frontmatter";
import type {
  GraphData,
  GraphLink,
  GraphNode,
  LinkReference,
  LinkType,
} from "../types";

const WIKILINK_PATTERN = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const EMBED_PATTERN = /!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const TAG_PATTERN = /#([a-zA-Z0-9_\-/]+)/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/g;

function normalizeSlug(path: string): string {
  return path.replace(/\.md$/, "").replace(/^\/+/, "").trim();
}

function extractConnections(
  body: string,
  frontmatter: Record<string, unknown> | null,
  allSlugs: Set<string>,
): LinkReference[] {
  const connections: LinkReference[] = [];

  // WikiLinks: [[link]] or [[link|alias]]
  for (const match of body.matchAll(WIKILINK_PATTERN)) {
    const slug = normalizeSlug(match[1] ?? "");
    if (slug && allSlugs.has(slug)) {
      connections.push({ target: slug, type: "link" });
    }
  }

  // Embeds: ![[note]]
  for (const match of body.matchAll(EMBED_PATTERN)) {
    const slug = normalizeSlug(match[1] ?? "");
    if (slug && allSlugs.has(slug)) {
      connections.push({ target: slug, type: "embed" });
    }
  }

  // Inline tags: #tag
  for (const match of body.matchAll(TAG_PATTERN)) {
    const tag = match[1];
    if (tag) {
      connections.push({ target: `tag:${tag}`, type: "tag" });
    }
  }

  // Standard markdown links: [text](url) — only internal
  for (const match of body.matchAll(MARKDOWN_LINK_PATTERN)) {
    const url = match[2] ?? "";
    if (url.startsWith("http://") || url.startsWith("https://")) continue;
    const internalMatch = url.match(/(?:\/|\.\.\/|\.\/)?([^/#?]+)/);
    if (internalMatch) {
      const slug = normalizeSlug(internalMatch[1] ?? "");
      if (slug && allSlugs.has(slug)) {
        connections.push({ target: slug, type: "link" });
      }
    }
  }

  // Frontmatter wikilinks
  if (frontmatter) {
    extractFrontmatterLinks(frontmatter, allSlugs, connections);
  }

  return connections;
}

function extractFrontmatterLinks(
  obj: unknown,
  allSlugs: Set<string>,
  connections: LinkReference[],
): void {
  if (!obj || typeof obj !== "object") return;

  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (typeof value === "string") {
      for (const match of value.matchAll(WIKILINK_PATTERN)) {
        const slug = normalizeSlug(match[1] ?? "");
        if (slug && allSlugs.has(slug)) {
          connections.push({ target: slug, type: "frontmatter" });
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" || typeof item === "object") {
          extractFrontmatterLinks({ _: item }, allSlugs, connections);
        }
      }
    } else if (typeof value === "object") {
      extractFrontmatterLinks(value, allSlugs, connections);
    }
  }
}

function extractTags(
  body: string,
  frontmatter: Record<string, unknown> | null,
): string[] {
  const tags: string[] = [];

  // Frontmatter tags
  if (frontmatter) {
    const fmTags = frontmatter.tags;
    if (Array.isArray(fmTags)) {
      tags.push(...fmTags.map(String));
    } else if (typeof fmTags === "string") {
      tags.push(fmTags);
    }
    const fmTag = frontmatter.tag;
    if (Array.isArray(fmTag)) {
      tags.push(...fmTag.map(String));
    } else if (typeof fmTag === "string") {
      tags.push(fmTag);
    }
  }

  // Inline tags
  for (const match of body.matchAll(TAG_PATTERN)) {
    const tag = match[1];
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  }

  return tags;
}

export interface FileEntry {
  relativePath: string;
  displayName: string;
  content: string;
}

export function buildGraphData(files: FileEntry[]): GraphData {
  const allSlugs = new Set(files.map((f) => normalizeSlug(f.relativePath)));

  const allTags = new Set<string>();
  const linkStrengthMap = new Map<
    string,
    Map<string, { count: number; types: Set<LinkType> }>
  >();
  const backlinkCounts = new Map<string, number>();

  for (const file of files) {
    const { frontmatter, body } = parseFrontmatter(file.content);
    const slug = normalizeSlug(file.relativePath);

    const connections = extractConnections(body, frontmatter, allSlugs);
    const fileTags = extractTags(body, frontmatter);

    for (const tag of fileTags) {
      allTags.add(tag);
      connections.push({ target: `tag:${tag}`, type: "tag" });
    }

    if (!linkStrengthMap.has(slug)) {
      linkStrengthMap.set(slug, new Map());
    }
    const targetMap = linkStrengthMap.get(slug)!;

    for (const conn of connections) {
      if (conn.type === "tag") {
        allTags.add(conn.target.replace("tag:", ""));
      }

      if (!targetMap.has(conn.target)) {
        targetMap.set(conn.target, { count: 0, types: new Set() });
      }
      const info = targetMap.get(conn.target)!;
      info.count += 1;
      info.types.add(conn.type);

      backlinkCounts.set(
        conn.target,
        (backlinkCounts.get(conn.target) ?? 0) + 1,
      );
    }

    if (!backlinkCounts.has(slug)) {
      backlinkCounts.set(slug, 0);
    }
  }

  const noteNodes: GraphNode[] = files.map((file) => {
    const slug = normalizeSlug(file.relativePath);
    const { frontmatter, body } = parseFrontmatter(file.content);
    const fileTags = extractTags(body, frontmatter);

    return {
      id: slug,
      title:
        (typeof frontmatter.title === "string" ? frontmatter.title : null) ??
        file.displayName,
      relativePath: file.relativePath,
      type: "note",
      backlinkCount: backlinkCounts.get(slug) ?? 0,
      tags: fileTags.length > 0 ? fileTags : undefined,
    };
  });

  const tagNodes: GraphNode[] = Array.from(allTags).map((tag) => ({
    id: `tag:${tag}`,
    title: `#${tag}`,
    relativePath: "",
    type: "tag",
    backlinkCount: backlinkCounts.get(`tag:${tag}`) ?? 0,
  }));

  const nodes = [...noteNodes, ...tagNodes];

  const links: GraphLink[] = [];
  for (const [source, targetMap] of linkStrengthMap) {
    for (const [target, info] of targetMap) {
      const primaryType: LinkType = info.types.has("link")
        ? "link"
        : info.types.has("embed")
          ? "embed"
          : info.types.has("frontmatter")
            ? "frontmatter"
            : "tag";

      links.push({
        source,
        target,
        strength: info.count,
        type: primaryType,
      });
    }
  }

  return { nodes, links };
}
