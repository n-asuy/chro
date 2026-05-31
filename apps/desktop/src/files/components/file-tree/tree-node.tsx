
import type React from "react";
import type { CSSProperties } from "react";
import { useEffect, useRef, useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@chro/ui/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import type { TreeNodeProps } from "../../types/file-tree";
import { FileNodeType } from "../../types/file-tree";
import { useFilesStore } from "../../state/files-store";
import { useLanguage, type TranslationFunction } from "@/i18n";

const formatFileSize = (bytes: number | undefined): string => {
  if (bytes === undefined || bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDateTime = (date: Date | undefined): string => {
  if (!date) return "";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
};

const formatRelativeTime = (
  date: Date | undefined,
  t: TranslationFunction,
): string => {
  if (!date) return "";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay > 0) return t("relativeTimeDaysAgo", { count: diffDay });
  if (diffHour > 0) return t("relativeTimeHoursAgo", { count: diffHour });
  if (diffMin > 0) return t("relativeTimeMinutesAgo", { count: diffMin });
  return t("relativeTimeJustNow");
};

interface TreeNodeExtraProps {
  isDragOver?: boolean;
  isDragging?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
}

export const TreeNode = ({
  node,
  isExpanded,
  isSelected,
  indentPx,
  onToggle,
  onSelect,
  onOpen,
  isDragOver,
  isDragging,
  onMouseDown,
}: TreeNodeProps & TreeNodeExtraProps) => {
  const { t } = useLanguage();
  const {
    editingPath,
    editingName,
    setEditingName,
    commitEditing,
    cancelEditing,
  } = useFilesStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const editingStartedAt = useRef<number>(0);
  const isEditing = editingPath === node.path;

  // Always show expand icon for directories (even empty ones)
  const isDirectory = node.type === FileNodeType.Directory;
  const indentStyle: CSSProperties = {
    paddingLeft: `${indentPx}px`,
  };

  // Focus input when editing starts
  useEffect(() => {
    if (!isEditing) {
      editingStartedAt.current = 0;
      return;
    }

    editingStartedAt.current = Date.now();

    // Use setTimeout to ensure the input is mounted before focusing
    const timerId = setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        // Select filename without extension for files
        const currentValue = inputRef.current.value;
        if (node.type === FileNodeType.File) {
          const dotIndex = currentValue.lastIndexOf(".");
          if (dotIndex > 0) {
            inputRef.current.setSelectionRange(0, dotIndex);
          } else {
            inputRef.current.select();
          }
        } else {
          inputRef.current.select();
        }
      }
    }, 0);

    return () => clearTimeout(timerId);
  }, [isEditing, node.type]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isEditing) return;
    onSelect();

    if (node.type === FileNodeType.File) {
      onOpen?.();
    } else if (node.type === FileNodeType.Directory) {
      onToggle();
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isEditing) return;
    if (node.type === FileNodeType.File) {
      onOpen?.();
    } else if (node.type === FileNodeType.Directory) {
      onToggle();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditingName(e.target.value);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitEditing();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEditing();
    }
  };

  const handleInputBlur = () => {
    // Ignore blur events within 200ms of editing start (to handle focus race conditions)
    const elapsed = Date.now() - editingStartedAt.current;
    if (elapsed < 200) {
      return;
    }
    void commitEditing();
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (isEditing) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
      return;
    }
    onMouseDown?.(e);
  };

  // Generate tooltip content for file metadata.
  const tooltipContent = useMemo(() => {
    const { metadata } = node;
    if (!metadata) return null;

    const lines: string[] = [];

    // File size
    const sizeStr = formatFileSize(metadata.size);
    if (sizeStr) {
      lines.push(sizeStr);
    }

    // Modified at
    if (metadata.modified) {
      const dateStr = formatDateTime(metadata.modified);
      const relativeStr = formatRelativeTime(metadata.modified, t);
      lines.push(
        t("fileTooltipModifiedAt", {
          datetime: dateStr,
          relative: relativeStr,
        }),
      );
    }

    // Created at (if available)
    if (metadata.created) {
      const dateStr = formatDateTime(metadata.created);
      const relativeStr = formatRelativeTime(metadata.created, t);
      lines.push(
        t("fileTooltipCreatedAt", { datetime: dateStr, relative: relativeStr }),
      );
    }

    if (lines.length === 0) return null;

    return (
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">{node.name}</span>
        {lines.map((line, index) => (
          <span key={index}>{line}</span>
        ))}
      </div>
    );
  }, [node, t]);

  const nodeContent = (
    <div
      className={cn(
        "font-workspace text-[12px] leading-[1.35] group flex min-h-[28px] cursor-pointer items-center rounded-[3px] mx-1 pr-2 text-custom-sidebar-text-200 hover:bg-custom-sidebar-background-80 hover:text-custom-sidebar-text-100",
        isSelected && "bg-[rgba(41,154,214,0.12)] text-custom-sidebar-text-100",
        isDragOver && "ring-2 ring-custom-primary-100 ring-inset bg-custom-primary-100/10",
        isDragging && "opacity-50",
      )}
      style={indentStyle}
      data-path={node.path}
      data-node-id={node.id}
      data-file-path={node.path}
      data-is-dir={isDirectory ? "true" : "false"}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleMouseDown}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mr-1 inline-flex h-5 w-5 items-center justify-center text-custom-sidebar-text-400",
          !isDirectory && "opacity-0",
        )}
      >
        <ChevronRight className={cn("size-4", isExpanded && "rotate-90")} />
      </span>
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editingName}
          onChange={handleInputChange}
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputBlur}
          className="min-w-0 flex-1 bg-custom-sidebar-background-100 border border-custom-border-300 rounded px-1 py-0.5 text-[12px] leading-[1.35] text-custom-sidebar-text-100 outline-none focus:border-custom-primary-100"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      )}
    </div>
  );

  // Show tooltip only when not editing and has metadata
  if (isEditing || !tooltipContent) {
    return nodeContent;
  }

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>{nodeContent}</TooltipTrigger>
        <TooltipContent side="right" align="start" sideOffset={8}>
          {tooltipContent}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
