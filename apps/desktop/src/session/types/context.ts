interface PartBase {
  content: string;
  start: number;
  end: number;
}

export interface TextPart extends PartBase {
  type: "text";
}

export interface FileAttachmentPart extends PartBase {
  type: "file";
  path: string;
  isFile: boolean;
  branch?: string | null;
}

export type ContentPart = TextPart | FileAttachmentPart;
export type Prompt = ContentPart[];

export const DEFAULT_PROMPT: Prompt = [
  { type: "text", content: "", start: 0, end: 0 },
];

const escapeXmlAttr = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export interface ContextEntry {
  path: string;
  isFile: boolean;
  branch?: string | null;
}

export function formatContextForPrompt(entries: ContextEntry[]): string {
  if (entries.length === 0) return "";
  const tags = entries
    .map((e) => {
      const tag = e.isFile ? "file" : "directory";
      const branchAttr = e.branch ? ` branch="${escapeXmlAttr(e.branch)}"` : "";
      return `<${tag} path="${escapeXmlAttr(e.path)}"${branchAttr} />`;
    })
    .join("\n");
  return `<context>\n${tags}\n</context>`;
}

export interface ImageEntry {
  name: string;
  path: string;
}

interface ParsedUserContent {
  contextEntries: ContextEntry[];
  imageEntries: ImageEntry[];
  text: string;
}

const unescapeXmlAttr = (s: string): string =>
  s
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const IMAGE_MD_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

function extractImages(text: string): {
  imageEntries: ImageEntry[];
  text: string;
} {
  const imageEntries: ImageEntry[] = [];
  const stripped = text.replace(IMAGE_MD_RE, (_, name: string, path: string) => {
    imageEntries.push({ name, path });
    return "";
  });
  return { imageEntries, text: stripped.replace(/^\n+/, "").replace(/\n+$/, "") };
}

export function parseContextFromContent(content: string): ParsedUserContent {
  const match = content.match(/^<context>\n([\s\S]*?)\n<\/context>/);
  if (!match) {
    const { imageEntries, text } = extractImages(content);
    return { contextEntries: [], imageEntries, text };
  }

  const entries: ContextEntry[] = [];
  const tagRegex = /<(file|directory)\s+path="([^"]*?)"(?:\s+branch="([^"]*?)")?\s*\/>/g;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(match[1])) !== null) {
    const entry: ContextEntry = {
      path: unescapeXmlAttr(tagMatch[2]),
      isFile: tagMatch[1] === "file",
    };
    if (tagMatch[3]) {
      entry.branch = unescapeXmlAttr(tagMatch[3]);
    }
    entries.push(entry);
  }

  const remaining = content.slice(match[0].length).replace(/^\n/, "");
  const { imageEntries, text } = extractImages(remaining);
  return { contextEntries: entries, imageEntries, text };
}

const SESSION_PATH_RE =
  /^\.chro-context\/sessions\/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/;

/** Return short session ID (first 8 hex chars) if `path` is a session transcript, else `null`. */
export function extractSessionId(path: string): string | null {
  const m = SESSION_PATH_RE.exec(path);
  return m ? m[1] : null;
}

export function getContextEntries(prompt: Prompt): ContextEntry[] {
  const seen = new Set<string>();
  const entries: ContextEntry[] = [];
  for (const part of prompt) {
    if (part.type === "file" && !seen.has(part.path)) {
      seen.add(part.path);
      const entry: ContextEntry = { path: part.path, isFile: part.isFile };
      if (part.branch) {
        entry.branch = part.branch;
      }
      entries.push(entry);
    }
  }
  return entries;
}
