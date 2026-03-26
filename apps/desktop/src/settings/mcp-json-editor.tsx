
import { useCallback, useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { cn } from "@/lib/cn";

type McpJsonEditorProps = {
  value: string;
  onChange: (nextValue: string) => void;
  disabled?: boolean;
  minHeight?: number;
  ariaLabel?: string;
  className?: string;
};

const DEFAULT_MIN_HEIGHT = 320;

export default function McpJsonEditor({
  value,
  onChange,
  disabled = false,
  minHeight = DEFAULT_MIN_HEIGHT,
  ariaLabel,
  className,
}: McpJsonEditorProps) {
  const [prefersDark, setPrefersDark] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    setPrefersDark(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => {
        mediaQuery.removeEventListener("change", handleChange);
      };
    }

    mediaQuery.addListener(handleChange);
    return () => {
      mediaQuery.removeListener(handleChange);
    };
  }, []);

  const editorTheme = useMemo(() => {
    if (typeof window === "undefined") return "vs-light";
    const datasetTheme =
      document.body?.dataset.theme ?? document.documentElement.dataset.theme;
    if (datasetTheme === "dark") return "vs-dark";
    if (datasetTheme === "light") return "vs-light";
    return prefersDark ? "vs-dark" : "vs-light";
  }, [prefersDark]);

  const editorHeight = Math.max(minHeight, 240);

  const handleChange = useCallback(
    (nextValue?: string) => {
      onChange(nextValue ?? "");
    },
    [onChange],
  );

  return (
    <div
      className={cn(
        "rounded border border-border/60 bg-custom-background-90",
        disabled && "opacity-60",
        className,
      )}
      style={{ minHeight: editorHeight }}
    >
      <Editor
        language="json"
        value={value}
        theme={editorTheme}
        onChange={handleChange}
        options={{
          readOnly: disabled,
          fontSize: 12,
          fontFamily:
            "ui-monospace, SFMono-Regular, 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace",
          padding: { top: 12, bottom: 12 },
          wordWrap: "on",
          minimap: { enabled: false },
          glyphMargin: false,
          scrollBeyondLastLine: false,
          renderLineHighlight: "all",
          formatOnPaste: true,
          formatOnType: true,
          automaticLayout: true,
          tabSize: 2,
          ariaLabel: ariaLabel ?? "MCP JSON editor",
        }}
        height={editorHeight}
        width="100%"
        loading={
          <div className="flex h-full min-h-[200px] items-center justify-center text-[11px] text-muted-foreground">
            Loading editor...
          </div>
        }
      />
    </div>
  );
}
