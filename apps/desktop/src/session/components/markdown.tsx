import { useLanguage } from "@/i18n";
import { openExpandedView } from "@/lib/mermaid-expanded-view";
import { openExternalUrl } from "@/lib/open-external-url";
import type { LocalImageMetadata } from "@/session/context/local-images-context";
import { useImageMetadata } from "@/session/hooks/use-image-metadata";
import { HelpCircle, Loader2, Maximize2 } from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  isValidElement,
  memo,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { normalizeFilePathHref } from "./file-path-utils";
import { remarkWikilink } from "./remark-wikilink";
import { useOpenPathLink, usePathLink } from "./use-path-link";
import { resolveWebUrl } from "./web-address";

type MarkdownProps = {
  children: string;
  onWikilinkClick?: (path: string, subpath?: string) => void;
  tone?: "default" | "muted";
  /** "document" renders the full heading scale; "flat" renders every heading
   * at body size in bold, for preview surfaces where document-scale headings
   * would shout (e.g. the sidebar hover preview). */
  headings?: "document" | "flat";
  localImages?: LocalImageMetadata[];
};

type MermaidViewMode = "rendered" | "raw";

const PATHLIKE_AUTOLINK_PATTERN = /^[A-Za-z][\w+.-]*:\d+(?::\d+)?$/;
const EXTERNAL_PROTOCOL_PATTERN = /^(https?:|mailto:|tel:)/i;

let sessionMermaidInstance: typeof import("mermaid").default | null = null;
let sessionMermaidTheme: "default" | "dark" | null = null;

const toChapterHeading = (input: string): string => {
  const lines = input.split(/\r?\n/);
  const chapterPattern = /^(第[0-9０-９]+章(?:[^\S\r\n].*)?)$/;

  return lines
    .map((line) => {
      if (!line || line.trim().startsWith("#")) {
        return line;
      }

      const matched = line.trim().match(chapterPattern);
      const heading = matched?.[1];
      if (!heading) {
        return line;
      }

      return `### ${heading.trim()}`;
    })
    .join("\n");
};

const extractText = (children: ReactNode): string => {
  if (typeof children === "string") {
    return children;
  }
  if (typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(extractText).join("");
  }
  if (isValidElement(children)) {
    const props = children.props as { children?: ReactNode };
    return extractText(props.children ?? "");
  }
  return "";
};

const getCodeElementFromPreChildren = (
  children: ReactNode,
): ReactElement<{ className?: string; children?: ReactNode }> | null => {
  if (Array.isArray(children)) {
    for (const child of children) {
      if (isValidElement(child)) {
        return child as ReactElement<{
          className?: string;
          children?: ReactNode;
        }>;
      }
    }
    return null;
  }

  if (!isValidElement(children)) {
    return null;
  }

  return children as ReactElement<{ className?: string; children?: ReactNode }>;
};

const resolveSafeHref = (href?: string): string | null => {
  if (typeof href !== "string") {
    return null;
  }

  const trimmed = href.trim();
  if (!trimmed || PATHLIKE_AUTOLINK_PATTERN.test(trimmed)) {
    return null;
  }

  if (trimmed.startsWith("#")) {
    return trimmed;
  }

  // A destination written without a scheme (`[配布](chro-ai.com)`) is still a
  // web address, and `new URL` cannot parse it — resolve it first so it does
  // not fall through to the local path handling below.
  const webUrl = resolveWebUrl(trimmed);
  if (webUrl) {
    return webUrl;
  }

  try {
    const parsed = new URL(trimmed);
    if (!EXTERNAL_PROTOCOL_PATTERN.test(parsed.protocol)) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
};

const isExternalHref = (href: string): boolean =>
  EXTERNAL_PROTOCOL_PATTERN.test(href);

const getSessionMermaid = async () => {
  const theme =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : "default";

  if (!sessionMermaidInstance) {
    const mermaid = (await import("mermaid")).default;
    sessionMermaidInstance = mermaid;
  }

  if (sessionMermaidTheme !== theme) {
    sessionMermaidInstance.initialize({
      startOnLoad: false,
      theme,
      securityLevel: "loose",
      fontFamily: "inherit",
    });
    sessionMermaidTheme = theme;
  }

  return sessionMermaidInstance;
};

const MermaidCodeBlock = ({ code }: { code: string }) => {
  const { t } = useLanguage();
  const [mode, setMode] = useState<MermaidViewMode>("rendered");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mermaidId = useId().replace(/[^A-Za-z0-9_-]/g, "");

  useEffect(() => {
    if (mode === "raw") {
      return undefined;
    }

    let cancelled = false;
    setSvg(null);
    setError(null);

    const renderDiagram = async () => {
      try {
        const mermaid = await getSessionMermaid();
        const isValid = await mermaid.parse(code, { suppressErrors: true });
        if (!isValid) {
          throw new Error(t("mermaidRenderError"));
        }

        const { svg: nextSvg } = await mermaid.render(
          `session-mermaid-${mermaidId}-${Date.now()}`,
          code,
        );

        if (!cancelled) {
          setSvg(nextSvg);
        }
      } catch {
        if (!cancelled) {
          setError(t("mermaidRenderError"));
        }
      }
    };

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [code, mermaidId, mode, t]);

  const tabButtonClass = (active: boolean) =>
    [
      "rounded-sm px-2 py-0.5 text-[11px] transition-colors",
      active
        ? "bg-muted text-foreground"
        : "text-muted-foreground hover:text-foreground",
    ].join(" ");
  const showRaw = mode === "raw" || Boolean(error);

  return (
    <div className="overflow-hidden rounded-sm border border-border/50 bg-muted/20">
      <div className="flex items-center justify-between border-b border-border/50 bg-muted/30 px-2 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Mermaid
        </span>
        <div className="inline-flex items-center gap-1">
          {mode === "rendered" && svg ? (
            <button
              type="button"
              className="flex h-[22px] w-[22px] items-center justify-center rounded-sm border border-border/60 bg-background/80 text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => openExpandedView(svg)}
              aria-label={t("mermaidExpandLabel")}
              title={t("mermaidExpandLabel")}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <div className="inline-flex items-center gap-0.5 rounded-sm border border-border/60 bg-background/80 p-0.5">
            <button
              type="button"
              className={tabButtonClass(mode === "rendered")}
              onClick={() => setMode("rendered")}
              aria-pressed={mode === "rendered"}
            >
              {t("mermaidRenderedLabel")}
            </button>
            <button
              type="button"
              className={tabButtonClass(mode === "raw")}
              onClick={() => setMode("raw")}
              aria-pressed={mode === "raw"}
            >
              {t("rawLabel")}
            </button>
          </div>
        </div>
      </div>

      {showRaw ? (
        <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] p-3 text-xs leading-relaxed font-mono">
          <code className="font-mono text-xs text-foreground [overflow-wrap:anywhere]">
            {code}
          </code>
        </pre>
      ) : (
        <div className="overflow-x-auto p-3">
          {svg ? (
            <div
              className="[&>svg]:h-auto [&>svg]:max-w-none [&>svg]:min-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{t("mermaidRenderingLabel")}</span>
            </div>
          )}
        </div>
      )}

      {error ? (
        <p className="border-t border-border/50 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
};

/** Shared by the plain and interactive forms, minus the text color: a link's
 * color must not compete with `text-foreground` in the same class list, where
 * stylesheet order and not authoring order decides the winner. */
const INLINE_CODE_CLASS =
  "box-decoration-clone rounded bg-muted px-1 font-mono text-xs [overflow-wrap:anywhere]";
const INTERACTIVE_CODE_CLASS =
  "cursor-pointer text-blue-600 dark:text-blue-400 hover:underline underline-offset-2";

const CodeRenderer: NonNullable<Components["code"]> = ({
  children,
  node,
  className,
  ...props
}) => {
  const text = extractText(children);
  const isCodeBlock =
    (node?.position
      ? node.position.start.line !== node.position.end.line
      : false) || text.includes("\n");

  // A web address reads as a link wherever it is written, and agents write them
  // in code spans (`chro-ai.com`). It is resolved before the file path branch
  // below: `chro-ai.com` also parses as a file name ending in a `.com`
  // extension, and opening it as a file is the wrong action.
  const webUrl = isCodeBlock ? null : resolveWebUrl(text);
  // Only what actually exists on disk becomes a link, so a decorated span
  // always opens something. Nothing is probed for code blocks or web addresses.
  const pathTarget = usePathLink(isCodeBlock || webUrl ? null : text);
  const openPathLink = useOpenPathLink();

  if (isCodeBlock) {
    return (
      <code
        className={[
          className,
          "font-mono text-xs text-foreground [overflow-wrap:anywhere]",
        ]
          .filter(Boolean)
          .join(" ")}
        {...props}
      >
        {children}
      </code>
    );
  }

  const interactiveCode = (
    activate: (event: React.SyntheticEvent) => void,
    title?: string,
  ) => (
    <code
      className={[className, INLINE_CODE_CLASS, INTERACTIVE_CODE_CLASS]
        .filter(Boolean)
        .join(" ")}
      role="link"
      tabIndex={0}
      title={title}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") activate(event);
      }}
      {...props}
    >
      {children}
    </code>
  );

  if (webUrl) {
    return interactiveCode((event) => {
      event.preventDefault();
      event.stopPropagation();
      openExternalUrl(webUrl);
    }, webUrl);
  }

  if (pathTarget) {
    return interactiveCode((event) => {
      event.preventDefault();
      event.stopPropagation();
      openPathLink(pathTarget);
    }, pathTarget.absolutePath);
  }

  return (
    <code
      className={[className, INLINE_CODE_CLASS, "text-foreground"]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      {children}
    </code>
  );
};

const preRenderer: NonNullable<Components["pre"]> = ({
  children,
  ...props
}) => {
  const codeElement = getCodeElementFromPreChildren(children);
  const className = codeElement?.props.className ?? "";
  const isMermaidBlock = /\blanguage-mermaid\b/i.test(className);

  if (isMermaidBlock) {
    const code = extractText(codeElement?.props.children ?? "").replace(
      /\n$/,
      "",
    );
    return <MermaidCodeBlock code={code} />;
  }

  return (
    <pre
      className="max-w-full overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md border border-border/50 bg-muted p-3 text-xs leading-relaxed font-mono"
      {...props}
    >
      {children}
    </pre>
  );
};

const truncatePath = (path: string, maxLength = 24): string => {
  const filename = path.split("/").pop() ?? path;
  if (filename.length <= maxLength) return filename;
  return filename.slice(0, maxLength - 3) + "...";
};

type MarkdownImageProps = {
  src?: string;
  alt?: string;
  localImages?: LocalImageMetadata[];
};

const MarkdownImage = ({ src, alt, localImages }: MarkdownImageProps) => {
  const { data: metadata, isLoading } = useImageMetadata(
    src ?? "",
    localImages,
  );
  const isChroImage = src?.startsWith(".chro-context/");

  if (isChroImage && src) {
    if (isLoading) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded border border-border bg-muted px-1.5 py-1 align-bottom">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-muted">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="max-w-[120px] truncate text-xs text-muted-foreground">
              {truncatePath(alt || src)}
            </span>
          </span>
        </span>
      );
    }

    if (metadata?.exists && metadata.proxy_url) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded border border-border bg-muted px-1.5 py-1 align-bottom">
          <img
            src={metadata.proxy_url}
            alt={alt ?? ""}
            className="h-10 w-10 flex-shrink-0 rounded object-cover"
            draggable={false}
          />
          <span className="flex min-w-0 flex-col">
            <span className="max-w-[120px] truncate text-xs text-muted-foreground">
              {truncatePath(metadata.file_name || alt || src)}
            </span>
            {metadata.format && (
              <span className="max-w-[120px] truncate text-[10px] text-muted-foreground/70">
                {metadata.format.toUpperCase()}
              </span>
            )}
          </span>
        </span>
      );
    }

    // Chro image but not found - show placeholder
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-border bg-muted px-1.5 py-1 align-bottom">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-muted">
          <HelpCircle className="h-5 w-5 text-muted-foreground" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="max-w-[120px] truncate text-xs text-muted-foreground">
            {truncatePath(alt || src)}
          </span>
        </span>
      </span>
    );
  }

  // Non-chro image: show placeholder with path
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-border bg-muted px-1.5 py-1 align-bottom">
      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-muted">
        <HelpCircle className="h-5 w-5 text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="max-w-[120px] truncate text-xs text-muted-foreground">
          {truncatePath(alt || src || "image")}
        </span>
      </span>
    </span>
  );
};

/**
 * A Markdown link whose href is a local path rather than a URL
 * (`[report](~/notes/report.html)`). It becomes a link only once the path is
 * confirmed to exist, and otherwise stays as the text the agent wrote.
 */
const LocalPathAnchor = ({
  href,
  textClass,
  children,
}: {
  href: string;
  textClass: string;
  children?: ReactNode;
}) => {
  const target = usePathLink(normalizeFilePathHref(href));
  const openPathLink = useOpenPathLink();

  if (!target) {
    return (
      <span className={`break-words [overflow-wrap:anywhere] ${textClass}`}>
        {children}
      </span>
    );
  }

  const handle = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openPathLink(target);
  };

  return (
    <a
      href={href}
      title={target.absolutePath}
      className="break-words [overflow-wrap:anywhere] font-medium text-blue-600 dark:text-blue-400 underline-offset-2 hover:underline cursor-pointer"
      role="link"
      tabIndex={0}
      onClick={handle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") handle(event);
      }}
    >
      {children}
    </a>
  );
};

const createComponents = (
  onWikilinkClick?: (path: string, subpath?: string) => void,
  tone: MarkdownProps["tone"] = "default",
  localImages?: LocalImageMetadata[],
  headings: MarkdownProps["headings"] = "document",
): Partial<Components> => {
  const textClass =
    tone === "muted" ? "text-muted-foreground" : "text-foreground";
  const subtleTextClass =
    tone === "muted" ? "text-muted-foreground/80" : "text-foreground/80";
  const flatHeading = ({ children }: { children?: ReactNode }) => (
    <p className={`mt-3 text-sm font-semibold leading-relaxed ${textClass}`}>
      {children}
    </p>
  );
  const flatHeadings: Partial<Components> =
    headings === "flat"
      ? {
          h1: flatHeading,
          h2: flatHeading,
          h3: flatHeading,
          h4: flatHeading,
          h5: flatHeading,
          h6: flatHeading,
        }
      : {};

  return {
    img: ({ src, alt }) => (
      <MarkdownImage src={src} alt={alt} localImages={localImages} />
    ),
    // Paragraphs own their leading gap: the wrapper's `space-y-3` only reaches
    // top-level blocks, so paragraphs nested in a blockquote or a loose list
    // item would otherwise sit flush against each other and a blank line in the
    // source would look identical to a single newline.
    p: ({ children }) => (
      <p
        className={`mt-3 break-words [overflow-wrap:anywhere] text-sm leading-relaxed first:mt-0 ${textClass}`}
      >
        {children}
      </p>
    ),
    strong: ({ children }) => (
      <strong className={`font-semibold ${textClass}`}>{children}</strong>
    ),
    em: ({ children }) => (
      <em className={`${subtleTextClass} not-italic`}>{children}</em>
    ),
    ul: ({ children, className }) => {
      const isTaskList =
        typeof className === "string" &&
        className.includes("contains-task-list");
      // Task lists have no marker, so they need no marker gutter; bulleted
      // lists keep `list-outside` markers and reserve room for them via
      // padding so they are never clipped by the renderer's overflow box.
      return (
        <ul
          className={`space-y-1 text-sm leading-relaxed ${isTaskList ? "list-none ps-1" : "list-disc list-outside ps-6"}`}
        >
          {children}
        </ul>
      );
    },
    // `list-outside` markers render in the start-edge gutter, so the <ol>
    // needs enough `padding-inline-start` (ps-6) to keep multi-digit numbers
    // (e.g. "10.") fully visible instead of being clipped by the overflow box.
    ol: ({ children }) => (
      <ol className="list-decimal list-outside space-y-1 ps-6 text-sm leading-relaxed">
        {children}
      </ol>
    ),
    li: ({ children, className }) => {
      const isTask =
        typeof className === "string" && className.includes("task-list-item");
      return (
        <li
          className={`${textClass} ${isTask ? "[&>input]:mr-1.5 [&>input]:align-middle" : ""}`}
        >
          {children}
        </li>
      );
    },
    input: ({ type, checked, disabled, ...props }) => {
      if (type === "checkbox") {
        return (
          <input
            type="checkbox"
            checked={checked ?? false}
            disabled={disabled}
            readOnly
            className="mr-1.5 align-middle accent-foreground"
            {...props}
          />
        );
      }
      return (
        <input type={type} checked={checked} disabled={disabled} {...props} />
      );
    },
    blockquote: ({ children }) => (
      <blockquote
        className={`border-l-2 border-muted-foreground/40 pl-3 text-sm italic ${subtleTextClass}`}
      >
        {children}
      </blockquote>
    ),
    a: ({ children, href }) => {
      const safeHref = resolveSafeHref(href);

      if (!safeHref) {
        if (typeof href === "string") {
          return (
            <LocalPathAnchor href={href} textClass={textClass}>
              {children}
            </LocalPathAnchor>
          );
        }
        return (
          <span className={`break-words [overflow-wrap:anywhere] ${textClass}`}>
            {children}
          </span>
        );
      }

      const external = isExternalHref(safeHref);

      return (
        <a
          href={safeHref}
          className="break-words [overflow-wrap:anywhere] font-medium text-blue-600 underline-offset-2 hover:underline"
          rel={external ? "noreferrer" : undefined}
          target={external ? "_blank" : undefined}
        >
          {children}
        </a>
      );
    },
    h1: ({ children }) => (
      <h1 className={`mt-6 text-xl font-semibold ${textClass}`}>{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className={`mt-5 text-lg font-semibold ${textClass}`}>{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className={`mt-4 text-base font-semibold ${textClass}`}>
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className={`mt-4 text-base font-semibold ${subtleTextClass}`}>
        {children}
      </h4>
    ),
    h5: ({ children }) => (
      <h5 className={`mt-3 text-sm font-semibold ${subtleTextClass}`}>
        {children}
      </h5>
    ),
    h6: ({ children }) => (
      <h6
        className={`mt-3 text-sm font-semibold ${subtleTextClass} uppercase tracking-wide`}
      >
        {children}
      </h6>
    ),
    code: CodeRenderer,
    pre: preRenderer,
    hr: () => <hr className="my-6 border-muted" />,
    table: ({ children }) => (
      // `contain: inline-size` stops the table's intrinsic width from
      // propagating up through the flex ancestors (whose `min-width: auto`
      // would otherwise grow to the table width and scroll the whole message
      // instead of just the table). Mirrors the CodeMirror table handling.
      <div className="my-4 max-w-full overflow-x-auto rounded-lg border border-border [contain:inline-size]">
        <table className="min-w-full divide-y divide-border text-sm">
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
    tbody: ({ children }) => (
      <tbody className="divide-y divide-border">{children}</tbody>
    ),
    tr: ({ children }) => <tr className="hover:bg-muted/50">{children}</tr>,
    th: ({ children, style }) => (
      <th
        className="min-w-[10rem] break-words px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        style={style}
      >
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td
        className="min-w-[10rem] break-words px-4 py-2.5 text-foreground"
        style={style}
      >
        {children}
      </td>
    ),
    // Wikilink renderer - custom node from remarkWikilink
    span: ({ node, children, ...props }) => {
      const className = props.className;
      const isWikilink =
        Array.isArray(className) && className.includes("wikilink");

      if (isWikilink) {
        const dataAttributes = props as Record<string, unknown>;
        const pathValue = dataAttributes["data-wikilink-path"];
        const subpathValue = dataAttributes["data-wikilink-subpath"];
        const path = typeof pathValue === "string" ? pathValue : undefined;
        const subpath =
          typeof subpathValue === "string" ? subpathValue : undefined;

        const handleClick = (e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (path && onWikilinkClick) {
            onWikilinkClick(path, subpath);
          }
        };

        return (
          <span
            className="cursor-pointer text-blue-600 underline-offset-2 hover:underline"
            onClick={handleClick}
            role="link"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (path && onWikilinkClick) {
                  onWikilinkClick(path, subpath);
                }
              }
            }}
          >
            {children}
          </span>
        );
      }

      return <span {...props}>{children}</span>;
    },
    ...flatHeadings,
  };
};

export const Markdown = memo(
  ({
    children,
    onWikilinkClick,
    tone = "default",
    headings = "document",
    localImages,
  }: MarkdownProps) => {
    const formatted = useMemo(
      () => toChapterHeading(children ?? ""),
      [children],
    );
    const components = useMemo(
      () => createComponents(onWikilinkClick, tone, localImages, headings),
      [onWikilinkClick, tone, localImages, headings],
    );
    const toneClass =
      tone === "muted" ? "text-muted-foreground" : "text-foreground";

    return (
      <div
        className={`min-w-0 max-w-full overflow-hidden space-y-3 break-words [overflow-wrap:anywhere] text-sm leading-relaxed ${toneClass}`}
      >
        <ReactMarkdown
          // remarkBreaks runs last so wikilink parsing still sees whole text
          // nodes. Agent output is chat prose, not a CommonMark document: a
          // newline the agent typed is a newline the reader is meant to see.
          remarkPlugins={[remarkGfm, remarkWikilink, remarkBreaks]}
          components={components}
        >
          {formatted}
        </ReactMarkdown>
      </div>
    );
  },
);

Markdown.displayName = "Markdown";
