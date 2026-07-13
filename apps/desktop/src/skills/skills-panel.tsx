import { useOptionalProjectContext } from "@/files/context/project-context";
import { useFilesStore } from "@/files/state/files-store";
import { fetchPreferences } from "@/lib/preferences-client";
import {
  type SkillProvider,
  type SkillScope,
  type SkillSummary,
  listSkills,
  skillProvider,
  skillScope,
} from "@/lib/skill-client";
import { useRightDockStore } from "@/workspace-layout/state/right-dock-store";
import { toast } from "@chro/ui/hooks/use-toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { cn } from "@chro/ui/utils";
import { BookOpen, FolderOpen, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const EMPTY_SKILLS: SkillSummary[] = [];

type ScopeFilter = SkillScope | "all";
type ProviderFilter = SkillProvider | "all";

const scopeLabels: Record<SkillScope, string> = {
  workspace: "Workspace",
  user: "User",
};

const providerLabels: Record<SkillProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  agents: "Agent Skills",
};

const PROVIDER_ORDER: SkillProvider[] = ["claude", "codex", "agents"];

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

function SegmentedFilter<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded border border-border p-0.5 text-xs">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded px-2 py-1 text-muted-foreground transition-colors",
            value === option.value
              ? "bg-muted text-foreground"
              : "hover:text-foreground",
          )}
        >
          {option.label}
          {option.count !== undefined ? (
            <span className="ml-1 tabular-nums opacity-50">{option.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/**
 * Map a skill package's absolute directory to the file tree's virtual path
 * (a leading-slash, forward-slash path relative to the workspace root). Only
 * skills that live under the workspace resolve; user/global skills (outside
 * the tree) and a missing workspace return null.
 */
function skillTreePath(
  absDir: string,
  workspacePath: string | null,
): string | null {
  if (!workspacePath) return null;
  const root = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const abs = absDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (abs === root) return "/";
  const prefix = `${root}/`;
  if (!abs.startsWith(prefix)) return null;
  const rel = abs.slice(prefix.length).replace(/^\/+/, "");
  return rel ? `/${rel}` : "/";
}

function SkillCard({
  skill,
  workspacePath,
  showHiddenEntries,
}: {
  skill: SkillSummary;
  workspacePath: string | null;
  showHiddenEntries: boolean;
}) {
  const scope = skillScope(skill);
  const provider = skillProvider(skill);
  const revealPath = useFilesStore((s) => s.revealPath);
  const openRightDockPanel = useRightDockStore((s) => s.setActivePanel);

  // Workspace skills live under the project root, so a click focuses them in
  // the file tree. User/global skills are outside the tree, so there is
  // nothing to reveal — the dedicated button is their only affordance.
  const treePath = useMemo(
    () =>
      scope === "workspace"
        ? skillTreePath(skill.abs_dir, workspacePath)
        : null,
    [scope, skill.abs_dir, workspacePath],
  );

  // A skill under a dot-directory (.claude, .agents) only appears in the tree
  // when hidden entries are shown; otherwise a reveal would land on nothing, so
  // the click opens the folder on disk instead of leaving a dead click.
  const revealable = useMemo(() => {
    if (!treePath) return false;
    if (showHiddenEntries) return true;
    return !treePath.split("/").some((segment) => segment.startsWith("."));
  }, [treePath, showHiddenEntries]);

  const openOnDisk = useCallback(async () => {
    try {
      await window.desktop?.openPath?.(skill.abs_dir);
    } catch {
      toast({ title: "Could not open skill folder", variant: "destructive" });
    }
  }, [skill.abs_dir]);

  const handleSelect = useCallback(() => {
    if (revealable && treePath) {
      openRightDockPanel("filetree");
      revealPath(treePath);
    } else {
      void openOnDisk();
    }
  }, [revealable, treePath, openRightDockPanel, revealPath, openOnDisk]);

  return (
    <div className="group relative h-full">
      <button
        type="button"
        onClick={handleSelect}
        title={
          revealable
            ? `${skill.source_path}\nReveal in file tree`
            : `${skill.source_path}\nOpen folder`
        }
        className={cn(
          "flex h-full w-full flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left",
          "transition-colors hover:border-foreground/20 hover:bg-accent/40",
        )}
      >
        <div className="flex items-center gap-2">
          <BookOpen className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate pr-6 text-sm font-medium">
            {skill.name}
          </span>
        </div>
        {skill.description ? (
          <p className="line-clamp-3 text-xs leading-5 text-muted-foreground">
            {skill.description}
          </p>
        ) : (
          <p className="text-xs italic text-muted-foreground/60">
            No description
          </p>
        )}
        <div className="mt-auto flex items-center gap-1.5 pt-1 text-[10px] text-muted-foreground">
          <span className="rounded border border-border px-1.5 py-0.5">
            {scopeLabels[scope]}
          </span>
          <span className="rounded border border-border px-1.5 py-0.5">
            {providerLabels[provider]}
          </span>
        </div>
      </button>
      <TooltipProvider delayDuration={120}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void openOnDisk()}
              aria-label="Open skill folder on disk"
              className={cn(
                "absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded",
                "text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground",
                "group-hover:opacity-70 focus-visible:opacity-100 focus-visible:outline-none",
              )}
            >
              <FolderOpen className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            Open folder on disk
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

/**
 * Skill browser rendered inside a workspace tab. Lists the bound project's
 * workspace skills plus the user's global skills in a single grid, tagged by
 * scope and provider and filterable by both, so neither bucket is buried.
 * Discovery is scoped to the current project's workspace path; without a
 * project only global skills are returned. Clicking a workspace skill focuses
 * its folder in the file tree (opening the right dock); the per-card button
 * opens the folder on disk. User/global skills are not in the tree, so a click
 * falls back to opening on disk.
 */
export function SkillsPanel() {
  const workspacePath = useOptionalProjectContext()?.workspacePath ?? null;
  const [skills, setSkills] = useState<SkillSummary[]>(EMPTY_SKILLS);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [showHiddenEntries, setShowHiddenEntries] = useState(false);
  const requestIdRef = useRef(0);

  // Whether the file tree surfaces dot-directories. Skills under .claude /
  // .agents can only be revealed there when this is on; the card click falls
  // back to opening on disk otherwise (see SkillCard.revealable).
  useEffect(() => {
    let cancelled = false;
    fetchPreferences()
      .then((res) => {
        if (!cancelled) {
          setShowHiddenEntries(Boolean(res.preferences.show_hidden_entries));
        }
      })
      .catch(() => {
        // Keep the hidden-off default when preferences cannot be read.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadSkills = useCallback(async () => {
    const id = ++requestIdRef.current;
    setLoading(true);
    try {
      const next = await listSkills(workspacePath);
      if (id === requestIdRef.current) setSkills(next);
    } catch {
      if (id === requestIdRef.current) setSkills(EMPTY_SKILLS);
    } finally {
      if (id === requestIdRef.current) setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const scopeCounts = useMemo(() => {
    let workspace = 0;
    for (const skill of skills) {
      if (skillScope(skill) === "workspace") workspace += 1;
    }
    return { workspace, user: skills.length - workspace };
  }, [skills]);

  const providerCounts = useMemo(() => {
    const counts: Record<SkillProvider, number> = {
      claude: 0,
      codex: 0,
      agents: 0,
    };
    for (const skill of skills) counts[skillProvider(skill)] += 1;
    return counts;
  }, [skills]);

  const scopeOptions = useMemo<SegmentOption<ScopeFilter>[]>(
    () => [
      { value: "all", label: "All" },
      { value: "workspace", label: "Workspace", count: scopeCounts.workspace },
      { value: "user", label: "User", count: scopeCounts.user },
    ],
    [scopeCounts],
  );

  // Only providers actually present get a chip, so the filter stays compact.
  const providerOptions = useMemo<SegmentOption<ProviderFilter>[]>(
    () => [
      { value: "all" as const, label: "All" },
      ...PROVIDER_ORDER.filter((p) => providerCounts[p] > 0).map((p) => ({
        value: p,
        label: providerLabels[p],
        count: providerCounts[p],
      })),
    ],
    [providerCounts],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (scope !== "all" && skillScope(skill) !== scope) return false;
      if (provider !== "all" && skillProvider(skill) !== provider) return false;
      if (!q) return true;
      return (
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.source_path.toLowerCase().includes(q)
      );
    });
  }, [skills, query, scope, provider]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills"
            className={cn(
              "h-8 w-full rounded border border-border bg-transparent pl-8 pr-2 text-sm",
              "outline-none placeholder:text-muted-foreground/50 focus:border-foreground/20",
            )}
          />
        </div>
        <SegmentedFilter
          options={scopeOptions}
          value={scope}
          onChange={setScope}
        />
        <SegmentedFilter
          options={providerOptions}
          value={provider}
          onChange={setProvider}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>Scanning skills…</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <BookOpen className="size-7 opacity-50" />
            <p className="text-sm">
              {skills.length === 0 ? "No skills found" : "No matching skills"}
            </p>
            <p className="max-w-xs text-xs leading-5 opacity-70">
              Looked in the workspace .claude / .agents / skills folders and your
              global ~/.claude, ~/.agents, ~/.codex skills.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-3">
            {visible.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                workspacePath={workspacePath}
                showHiddenEntries={showHiddenEntries}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
