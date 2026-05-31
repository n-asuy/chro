import {
  type SkillSummary,
  listSkills,
  skillSourceLabel,
} from "@/lib/skill-client";
import { cn } from "@chro/ui/utils";
import { BookOpen, Loader2 } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

export interface SkillPopoverHandle {
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

interface SkillPopoverProps {
  open: boolean;
  query: string;
  workspacePath: string | null;
  onSelect: (skill: SkillSummary) => void;
  onClose: () => void;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
}

const DEBOUNCE_MS = 120;

export const SkillPopover = forwardRef<SkillPopoverHandle, SkillPopoverProps>(
  (
    {
      open,
      query,
      workspacePath,
      onSelect,
      onClose,
      activeIndex,
      onActiveIndexChange,
    },
    ref,
  ) => {
    const [skills, setSkills] = useState<SkillSummary[]>([]);
    const [debouncedQuery, setDebouncedQuery] = useState(query);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const requestIdRef = useRef(0);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const timer = window.setTimeout(() => {
        setDebouncedQuery(query);
      }, DEBOUNCE_MS);
      return () => window.clearTimeout(timer);
    }, [query]);

    useEffect(() => {
      if (!open) return;

      const id = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      listSkills(workspacePath)
        .then((result) => {
          if (id !== requestIdRef.current) return;
          setSkills(result);
          onActiveIndexChange(0);
        })
        .catch((err) => {
          if (id !== requestIdRef.current) return;
          setSkills([]);
          setError(
            err instanceof Error ? err.message : "Failed to load skills",
          );
          onActiveIndexChange(0);
        })
        .finally(() => {
          if (id === requestIdRef.current) {
            setLoading(false);
          }
        });
    }, [open, workspacePath, onActiveIndexChange]);

    const filteredSkills = useMemo(() => {
      const q = debouncedQuery.trim().toLowerCase();
      if (!q) return skills;
      return skills.filter((skill) => {
        return (
          skill.name.toLowerCase().includes(q) ||
          skill.description.toLowerCase().includes(q) ||
          skill.source_path.toLowerCase().includes(q)
        );
      });
    }, [skills, debouncedQuery]);

    useEffect(() => {
      if (!listRef.current) return;
      const active = listRef.current.children[activeIndex] as
        | HTMLElement
        | undefined;
      active?.scrollIntoView({ block: "nearest" });
    }, [activeIndex]);

    useEffect(() => {
      if (activeIndex >= filteredSkills.length) {
        onActiveIndexChange(Math.max(0, filteredSkills.length - 1));
      }
    }, [activeIndex, filteredSkills.length, onActiveIndexChange]);

    const handleSelectSkill = useCallback(
      (skill: SkillSummary) => {
        onSelect(skill);
      },
      [onSelect],
    );

    const handleKeyDownInternal = useCallback(
      (e: React.KeyboardEvent): boolean => {
        switch (e.key) {
          case "ArrowDown":
            if (filteredSkills.length === 0) return false;
            onActiveIndexChange(
              Math.min(activeIndex + 1, filteredSkills.length - 1),
            );
            return true;
          case "ArrowUp":
            if (filteredSkills.length === 0) return false;
            onActiveIndexChange(Math.max(activeIndex - 1, 0));
            return true;
          case "Tab":
          case "Enter": {
            const selected = filteredSkills[activeIndex];
            if (selected) {
              handleSelectSkill(selected);
              return true;
            }
            return false;
          }
          case "Escape":
            onClose();
            return true;
          default:
            return false;
        }
      },
      [
        activeIndex,
        filteredSkills,
        onActiveIndexChange,
        handleSelectSkill,
        onClose,
      ],
    );

    useImperativeHandle(
      ref,
      () => ({
        handleKeyDown: handleKeyDownInternal,
      }),
      [handleKeyDownInternal],
    );

    if (!open) return null;

    return (
      <div
        className="absolute bottom-full left-0 z-50 mb-2 w-full max-w-md overflow-hidden rounded-lg border border-border/60 bg-popover shadow-custom-shadow-sm"
        onMouseDown={(e) => e.preventDefault()}
      >
        <div className="border-border/40 border-b px-2 py-1.5 text-[11px] text-muted-foreground">
          Skills
        </div>
        <div ref={listRef} className="max-h-[320px] overflow-y-auto p-1">
          {loading ? (
            <div className="flex items-center gap-2.5 px-2 py-1.5 text-[13px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Loading skills...</span>
            </div>
          ) : error ? (
            <div className="px-2 py-1.5 text-[13px] text-muted-foreground">
              {error}
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="px-2 py-1.5 text-[13px] text-muted-foreground">
              {debouncedQuery ? "No matching skills" : "No skills found"}
            </div>
          ) : (
            filteredSkills.map((skill, index) => (
              <button
                key={skill.id}
                type="button"
                className={cn(
                  "flex w-full items-start gap-2.5 rounded px-2 py-1 text-left text-[13px] transition-colors",
                  index === activeIndex
                    ? "bg-accent/60 text-accent-foreground"
                    : "hover:bg-accent/30",
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelectSkill(skill);
                }}
                onMouseEnter={() => onActiveIndexChange(index)}
              >
                <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{skill.name}</span>
                  {skill.description ? (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {skill.description}
                    </span>
                  ) : null}
                </span>
                <span className="mt-[3px] shrink-0 text-[10px] text-muted-foreground">
                  {skillSourceLabel(skill)}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  },
);

SkillPopover.displayName = "SkillPopover";
