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

/**
 * Past chro session attachment. The runtime never copies a file or inlines
 * markdown; the rendered prompt carries a self-describing tag and the agent
 * fetches the transcript on demand via `chro task logs <task_id>`.
 */
export interface SessionAttachmentPart extends PartBase {
  type: "session";
  taskId: string;
  branch?: string | null;
}

export interface SkillAttachmentPart extends PartBase {
  type: "skill";
  id: string;
  name: string;
}

export type ContentPart =
  | TextPart
  | FileAttachmentPart
  | SessionAttachmentPart
  | SkillAttachmentPart;
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

export interface FileContextEntry {
  kind: "file";
  path: string;
  isFile: boolean;
  branch?: string | null;
}

export interface SessionContextEntry {
  kind: "session";
  taskId: string;
  branch?: string | null;
}

export type ContextEntry = FileContextEntry | SessionContextEntry;

export type ContextRefPayload =
  | {
      kind: "file" | "directory";
      path: string;
      branch?: string | null;
      mode?: "link";
    }
  | {
      kind: "session";
      task_id: string;
      branch?: string | null;
      mode?: "transcript";
    };

export interface SkillEntry {
  id: string;
  name: string;
}

const renderFileContextEntry = (e: FileContextEntry): string => {
  const tag = e.isFile ? "file" : "directory";
  const branchAttr = e.branch ? ` branch="${escapeXmlAttr(e.branch)}"` : "";
  return `<${tag} path="${escapeXmlAttr(e.path)}"${branchAttr} />`;
};

const renderSessionContextEntry = (e: SessionContextEntry): string => {
  const branchAttr = e.branch ? ` branch="${escapeXmlAttr(e.branch)}"` : "";
  return [
    `<past_session task_id="${escapeXmlAttr(e.taskId)}"${branchAttr}>`,
    `Run \`chro task logs ${e.taskId}\` to view the full transcript of this previous chro session.`,
    "</past_session>",
  ].join("\n");
};

export function formatContextForPrompt(entries: ContextEntry[]): string {
  if (entries.length === 0) return "";
  const tags = entries
    .map((e) =>
      e.kind === "file"
        ? renderFileContextEntry(e)
        : renderSessionContextEntry(e),
    )
    .join("\n");
  return `<context>\n${tags}\n</context>`;
}

export function contextEntriesToRefs(
  entries: ContextEntry[],
): ContextRefPayload[] {
  return entries.map((entry) => {
    if (entry.kind === "file") {
      return {
        kind: entry.isFile ? "file" : "directory",
        path: entry.path,
        ...(entry.branch ? { branch: entry.branch } : {}),
        mode: "link",
      };
    }
    return {
      kind: "session",
      task_id: entry.taskId,
      ...(entry.branch ? { branch: entry.branch } : {}),
      mode: "transcript",
    };
  });
}

export function formatSkillContextForPrompt(entries: SkillEntry[]): string {
  if (entries.length === 0) return "";
  const tags = entries
    .map(
      (entry) =>
        `<skill id="${escapeXmlAttr(entry.id)}" name="${escapeXmlAttr(entry.name)}" />`,
    )
    .join("\n");
  return `<skills_context>\n${tags}\n</skills_context>`;
}

export interface ImageEntry {
  name: string;
  path: string;
}

interface ParsedUserContent {
  contextEntries: ContextEntry[];
  skillEntries: SkillEntry[];
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
  const stripped = text.replace(
    IMAGE_MD_RE,
    (_, name: string, path: string) => {
      imageEntries.push({ name, path });
      return "";
    },
  );
  return {
    imageEntries,
    text: stripped.replace(/^\n+/, "").replace(/\n+$/, ""),
  };
}

const FILE_TAG_RE =
  /<(file|directory)\s+path="([^"]*?)"(?:\s+branch="([^"]*?)")?\s*\/>/g;
const SESSION_TAG_RE =
  /<past_session\s+task_id="([^"]*?)"(?:\s+branch="([^"]*?)")?\s*>([\s\S]*?)<\/past_session>/g;
const SKILL_TAG_RE = /<skill\s+id="([^"]*?)"\s+name="([^"]*?)"\s*\/>/g;
const CONTEXT_BLOCK_RE = /^<context>\n([\s\S]*?)\n<\/context>/;
const SKILLS_CONTEXT_BLOCK_RE =
  /^<skills_context>\n([\s\S]*?)\n<\/skills_context>/;

function parseContextEntries(inner: string): ContextEntry[] {
  const indexed: Array<{ index: number; entry: ContextEntry }> = [];

  let fileMatch: RegExpExecArray | null = FILE_TAG_RE.exec(inner);
  while (fileMatch !== null) {
    const entry: FileContextEntry = {
      kind: "file",
      path: unescapeXmlAttr(fileMatch[2]),
      isFile: fileMatch[1] === "file",
    };
    if (fileMatch[3]) {
      entry.branch = unescapeXmlAttr(fileMatch[3]);
    }
    indexed.push({ index: fileMatch.index, entry });
    fileMatch = FILE_TAG_RE.exec(inner);
  }

  let sessionMatch: RegExpExecArray | null = SESSION_TAG_RE.exec(inner);
  while (sessionMatch !== null) {
    const entry: SessionContextEntry = {
      kind: "session",
      taskId: unescapeXmlAttr(sessionMatch[1]),
    };
    if (sessionMatch[2]) {
      entry.branch = unescapeXmlAttr(sessionMatch[2]);
    }
    indexed.push({ index: sessionMatch.index, entry });
    sessionMatch = SESSION_TAG_RE.exec(inner);
  }

  indexed.sort((a, b) => a.index - b.index);
  return indexed.map((i) => i.entry);
}

function parseSkillEntries(inner: string): SkillEntry[] {
  const entries: SkillEntry[] = [];

  let skillMatch: RegExpExecArray | null = SKILL_TAG_RE.exec(inner);
  while (skillMatch !== null) {
    entries.push({
      id: unescapeXmlAttr(skillMatch[1]),
      name: unescapeXmlAttr(skillMatch[2]),
    });
    skillMatch = SKILL_TAG_RE.exec(inner);
  }

  return entries;
}

export function parseContextFromContent(content: string): ParsedUserContent {
  const contextEntries: ContextEntry[] = [];
  const skillEntries: SkillEntry[] = [];
  let remaining = content;

  let consumedBlock = true;
  while (consumedBlock) {
    consumedBlock = false;

    const contextMatch = remaining.match(CONTEXT_BLOCK_RE);
    if (contextMatch) {
      contextEntries.push(...parseContextEntries(contextMatch[1]));
      remaining = remaining.slice(contextMatch[0].length).replace(/^\n+/, "");
      consumedBlock = true;
      continue;
    }

    const skillsMatch = remaining.match(SKILLS_CONTEXT_BLOCK_RE);
    if (skillsMatch) {
      skillEntries.push(...parseSkillEntries(skillsMatch[1]));
      remaining = remaining.slice(skillsMatch[0].length).replace(/^\n+/, "");
      consumedBlock = true;
    }
  }

  const { imageEntries, text } = extractImages(remaining);
  return { contextEntries, skillEntries, imageEntries, text };
}

function createGeneratedSessionTitle(now: Date = new Date()): string {
  return `Session ${now.toISOString().slice(0, 16).replace("T", " ")}`;
}

export function inferTaskTitleFromContent(
  content: string,
  fallback: () => string = () => createGeneratedSessionTitle(),
): string {
  const firstLine = parseContextFromContent(content)
    .text.split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();

  if (!firstLine) {
    return fallback();
  }

  return firstLine.slice(0, 80);
}

export function inferTaskDescriptionFromContent(
  content: string,
): string | null {
  const textLines = parseContextFromContent(content).text.split(/\r?\n/);
  const firstLineIndex = textLines.findIndex((line) => line.trim().length > 0);
  if (firstLineIndex === -1) {
    return null;
  }

  const remainingText =
    firstLineIndex === -1
      ? ""
      : textLines
          .slice(firstLineIndex + 1)
          .join("\n")
          .trim();
  return remainingText || null;
}

/** Short display id (first 8 chars of UUID) for a past session. */
export function shortSessionId(taskId: string): string {
  return taskId.slice(0, 8);
}

export function getContextEntries(prompt: Prompt): ContextEntry[] {
  const seenFiles = new Set<string>();
  const seenSessions = new Set<string>();
  const entries: ContextEntry[] = [];
  for (const part of prompt) {
    if (part.type === "file" && !seenFiles.has(part.path)) {
      seenFiles.add(part.path);
      const entry: FileContextEntry = {
        kind: "file",
        path: part.path,
        isFile: part.isFile,
      };
      if (part.branch) {
        entry.branch = part.branch;
      }
      entries.push(entry);
    } else if (part.type === "session" && !seenSessions.has(part.taskId)) {
      seenSessions.add(part.taskId);
      const entry: SessionContextEntry = {
        kind: "session",
        taskId: part.taskId,
      };
      if (part.branch) {
        entry.branch = part.branch;
      }
      entries.push(entry);
    }
  }
  return entries;
}

export function getSkillEntries(prompt: Prompt): SkillEntry[] {
  const seen = new Set<string>();
  const entries: SkillEntry[] = [];
  for (const part of prompt) {
    if (part.type === "skill" && !seen.has(part.id)) {
      seen.add(part.id);
      entries.push({ id: part.id, name: part.name });
    }
  }
  return entries;
}
