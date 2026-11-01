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
 * fetches the transcript on demand via
 * `chro session read <task_id> --format markdown`.
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

/** CSS-pixel box of an annotated element, relative to the page viewport. */
export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One comment the user pinned on an element of a rendered page. */
export interface PageAnnotation {
  /** CSS selector that resolves to the element within the page. */
  selector: string;
  /** Short human label, e.g. `button "Start trial"`. */
  element: string;
  /** Visible text of the element, trimmed, when it has any. */
  text?: string;
  rect: AnnotationRect;
  comment: string;
}

/** Every comment made on one rendered document in a single annotation pass. */
export interface PageAnnotations {
  /** Path of the annotated document, as the editor names it. */
  path: string;
  viewport: { width: number; height: number } | null;
  notes: PageAnnotation[];
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Shape check for notes that crossed a trust boundary (a pill's dataset, a
 * persisted draft, a message from the preview frame).
 */
export function isPageAnnotation(value: unknown): value is PageAnnotation {
  if (!value || typeof value !== "object") return false;
  const note = value as Record<string, unknown>;
  const rect = note.rect as Record<string, unknown> | null | undefined;
  return (
    typeof note.selector === "string" &&
    typeof note.element === "string" &&
    typeof note.comment === "string" &&
    (note.text === undefined || typeof note.text === "string") &&
    !!rect &&
    typeof rect === "object" &&
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height)
  );
}

/** Label shown on the composer pill for an annotation pass. */
export function annotationsDisplayContent(page: PageAnnotations): string {
  const name = page.path.split("/").pop() || page.path;
  const count = page.notes.length;
  return `${name} · ${count} ${count === 1 ? "note" : "notes"}`;
}

export interface AnnotationsAttachmentPart extends PartBase, PageAnnotations {
  type: "annotations";
}

export type ContentPart =
  | TextPart
  | FileAttachmentPart
  | SessionAttachmentPart
  | SkillAttachmentPart
  | AnnotationsAttachmentPart;
export type Prompt = ContentPart[];

/**
 * Shape check for a part read back from storage. A part type this build does
 * not know, or one whose payload lost its shape, is rejected rather than
 * restored half-formed.
 */
export function isContentPart(value: unknown): value is ContentPart {
  if (!value || typeof value !== "object") return false;
  const part = value as Record<string, unknown>;
  if (
    typeof part.type !== "string" ||
    typeof part.content !== "string" ||
    typeof part.start !== "number" ||
    typeof part.end !== "number"
  ) {
    return false;
  }

  switch (part.type) {
    case "text":
      return true;
    case "file":
      return typeof part.path === "string" && typeof part.isFile === "boolean";
    case "session":
      return typeof part.taskId === "string";
    case "skill":
      return typeof part.id === "string" && typeof part.name === "string";
    case "annotations":
      return (
        typeof part.path === "string" &&
        (part.viewport === null || isViewport(part.viewport)) &&
        Array.isArray(part.notes) &&
        part.notes.every(isPageAnnotation)
      );
    default:
      return false;
  }
}

function isViewport(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const viewport = value as Record<string, unknown>;
  return isFiniteNumber(viewport.width) && isFiniteNumber(viewport.height);
}

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

export interface AnnotationsContextEntry extends PageAnnotations {
  kind: "annotations";
}

export type ContextEntry =
  | FileContextEntry
  | SessionContextEntry
  | AnnotationsContextEntry;

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
    `Referenced session. A summary is injected at execution time; run \`chro session read ${e.taskId} --format markdown\` for the full transcript.`,
    "</past_session>",
  ].join("\n");
};

const ANNOTATIONS_DESCRIPTION =
  "Comments the user pinned on elements of the rendered page. selector is a CSS selector within that document; rect is x,y,width,height in CSS pixels of the viewport.";

const renderAnnotationsContextEntry = (e: AnnotationsContextEntry): string => {
  const viewportAttr = e.viewport
    ? ` viewport="${e.viewport.width}x${e.viewport.height}"`
    : "";
  const notes = e.notes.map((note, index) => {
    const { x, y, width, height } = note.rect;
    return [
      `<annotation n="${index + 1}" selector="${escapeXmlAttr(note.selector)}" rect="${x},${y},${width},${height}">`,
      `<element>${escapeXmlAttr(note.element)}</element>`,
      ...(note.text ? [`<text>${escapeXmlAttr(note.text)}</text>`] : []),
      `<comment>${escapeXmlAttr(note.comment)}</comment>`,
      "</annotation>",
    ].join("\n");
  });
  return [
    `<page_annotations path="${escapeXmlAttr(e.path)}"${viewportAttr}>`,
    ANNOTATIONS_DESCRIPTION,
    ...notes,
    "</page_annotations>",
  ].join("\n");
};

const renderContextEntry = (e: ContextEntry): string => {
  switch (e.kind) {
    case "file":
      return renderFileContextEntry(e);
    case "session":
      return renderSessionContextEntry(e);
    case "annotations":
      return renderAnnotationsContextEntry(e);
  }
};

export function formatContextForPrompt(entries: ContextEntry[]): string {
  if (entries.length === 0) return "";
  const tags = entries.map(renderContextEntry).join("\n");
  return `<context>\n${tags}\n</context>`;
}

export function contextEntriesToRefs(
  entries: ContextEntry[],
): ContextRefPayload[] {
  return entries.map((entry) => {
    if (entry.kind === "annotations") {
      // The annotated document is what the agent has to open and edit.
      return { kind: "file", path: entry.path, mode: "link" };
    }
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
const PAGE_ANNOTATIONS_RE =
  /<page_annotations\s+path="([^"]*?)"(?:\s+viewport="(\d+)x(\d+)")?\s*>([\s\S]*?)<\/page_annotations>/g;
const ANNOTATION_RE =
  /<annotation\s+n="\d+"\s+selector="([^"]*?)"\s+rect="(-?\d+),(-?\d+),(\d+),(\d+)"\s*>([\s\S]*?)<\/annotation>/g;
const ANNOTATION_ELEMENT_RE = /<element>([\s\S]*?)<\/element>/;
const ANNOTATION_TEXT_RE = /<text>([\s\S]*?)<\/text>/;
const ANNOTATION_COMMENT_RE = /<comment>([\s\S]*?)<\/comment>/;
const SKILL_TAG_RE = /<skill\s+id="([^"]*?)"\s+name="([^"]*?)"\s*\/>/g;
const CONTEXT_BLOCK_RE = /^<context>\n([\s\S]*?)\n<\/context>/;
const SKILLS_CONTEXT_BLOCK_RE =
  /^<skills_context>\n([\s\S]*?)\n<\/skills_context>/;

function parseAnnotationNotes(inner: string): PageAnnotation[] {
  const notes: PageAnnotation[] = [];
  for (const match of inner.matchAll(ANNOTATION_RE)) {
    const body = match[6];
    const comment = body.match(ANNOTATION_COMMENT_RE);
    if (!comment) continue;
    const note: PageAnnotation = {
      selector: unescapeXmlAttr(match[1]),
      element: unescapeXmlAttr(body.match(ANNOTATION_ELEMENT_RE)?.[1] ?? ""),
      rect: {
        x: Number(match[2]),
        y: Number(match[3]),
        width: Number(match[4]),
        height: Number(match[5]),
      },
      comment: unescapeXmlAttr(comment[1]),
    };
    const text = body.match(ANNOTATION_TEXT_RE);
    if (text) note.text = unescapeXmlAttr(text[1]);
    notes.push(note);
  }
  return notes;
}

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

  for (const match of inner.matchAll(PAGE_ANNOTATIONS_RE)) {
    indexed.push({
      index: match.index,
      entry: {
        kind: "annotations",
        path: unescapeXmlAttr(match[1]),
        viewport:
          match[2] && match[3]
            ? { width: Number(match[2]), height: Number(match[3]) }
            : null,
        notes: parseAnnotationNotes(match[4]),
      },
    });
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
    } else if (part.type === "annotations") {
      // Each annotation pass is its own entry: two passes on the same page
      // carry different comments and must both reach the agent.
      entries.push({
        kind: "annotations",
        path: part.path,
        viewport: part.viewport,
        notes: part.notes,
      });
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
