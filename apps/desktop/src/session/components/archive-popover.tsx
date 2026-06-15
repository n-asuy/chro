
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@chro/ui/popover";
import { Input } from "@chro/ui/input";
import { Archive, RotateCcw, Search } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ArchivedSession } from "../hooks/use-archived-sessions";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

const formatTime = (dateInput: Date | string) => {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
  return `${Math.floor(diffDays / 365)}y`;
};

const shortIdFromUuid = (id?: string | null, length = 8): string | null => {
  if (!id) return null;
  const compact = id.replace(/-/g, "");
  if (!compact) return null;
  return compact.slice(0, length).toLowerCase();
};

interface ArchivedSessionItemProps {
  session: ArchivedSession;
  index: number;
  isSelected: boolean;
  onRestore: (id: string) => void;
  setRef: (index: number, el: HTMLDivElement | null) => void;
}

const ArchivedSessionItem = memo(function ArchivedSessionItem({
  session,
  index,
  isSelected,
  onRestore,
  setRef,
}: ArchivedSessionItemProps) {
  const shortId = shortIdFromUuid(session.id);

  const handleRestore = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onRestore(session.id);
    },
    [onRestore, session.id]
  );

  const handleRef = useCallback(
    (el: HTMLDivElement | null) => {
      setRef(index, el);
    },
    [setRef, index]
  );

  return (
    <div
      ref={handleRef}
      className={cn(
        "w-[calc(100%-8px)] mx-1 text-left min-h-[32px] py-[5px] px-1.5 rounded-md transition-colors duration-150 cursor-pointer group relative",
        "outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
        isSelected
          ? "bg-custom-sidebar-background-80 text-foreground"
          : "text-muted-foreground hover:bg-custom-sidebar-background-80 hover:text-foreground"
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <span className="truncate block text-sm leading-tight flex-1">
              {session.title || (
                <span className="text-muted-foreground/50">Untitled</span>
              )}
            </span>
            <button
              onClick={handleRestore}
              className="flex-shrink-0 text-muted-foreground hover:text-foreground active:text-foreground transition-[color,transform] duration-150 ease-out active:scale-[0.97]"
              aria-label="Restore session"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          </div>
          <div className="flex items-center justify-between gap-2">
            {shortId ? (
              <span className="text-[11px] font-mono tracking-wide text-muted-foreground/60 truncate">
                {shortId}
              </span>
            ) : null}
            <span className="text-[11px] text-muted-foreground/60 flex-shrink-0">
              {formatTime(session.archivedAt)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

interface ArchivePopoverProps {
  trigger: React.ReactNode;
  archivedSessions: ArchivedSession[];
  onRestore: (sessionId: string) => void;
}

export const ArchivePopover = memo(function ArchivePopover({
  trigger,
  archivedSessions,
  onRestore,
}: ArchivePopoverProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const popoverContentRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Filter and sort archived sessions (newest first)
  const filteredSessions = useMemo(() => {
    return archivedSessions
      .filter((session) => {
        if (
          searchQuery.trim() &&
          !(session.title ?? "")
            .toLowerCase()
            .includes(searchQuery.toLowerCase())
        ) {
          return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime()
      );
  }, [archivedSessions, searchQuery]);

  // Clear search query when popover opens
  useEffect(() => {
    if (open) {
      setSearchQuery("");
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
    }
  }, [open]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (filteredSessions.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredSessions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(
          (prev) =>
            (prev - 1 + filteredSessions.length) % filteredSessions.length
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const session = filteredSessions[selectedIndex];
        if (session) {
          onRestore(session.id);
          setOpen(false);
        }
      }
    },
    [filteredSessions, selectedIndex, onRestore]
  );

  // Reset selected index when search changes
  useEffect(() => {
    setSelectedIndex(0);
    itemRefs.current = [];
  }, [searchQuery]);

  // Scroll selected item into view
  useEffect(() => {
    const selectedElement = itemRefs.current[selectedIndex];
    if (selectedElement) {
      selectedElement.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [selectedIndex]);

  // Auto-close popover when archive becomes empty
  useEffect(() => {
    if (open && archivedSessions.length === 0) {
      setOpen(false);
    }
  }, [archivedSessions, open]);

  // Memoized callbacks
  const handleRestoreSession = useCallback(
    (id: string) => {
      onRestore(id);
    },
    [onRestore]
  );

  const handleSetRef = useCallback(
    (index: number, el: HTMLDivElement | null) => {
      itemRefs.current[index] = el;
    },
    []
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
    },
    []
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        ref={popoverContentRef}
        side="right"
        align="end"
        sideOffset={8}
        className="w-[250px] h-[400px] p-0 flex flex-col overflow-hidden"
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        {/* Search */}
        <div className="px-1 pt-1 pb-1 border-b">
          <div className="relative flex items-center gap-1.5 h-7 px-1.5 mx-1 rounded-md bg-muted/50">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Input
              ref={searchInputRef}
              placeholder="Search..."
              value={searchQuery}
              onChange={handleSearchChange}
              className="h-auto p-0 border-0 bg-transparent text-sm placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
        </div>

        {/* Archived Sessions List */}
        <div className="flex-1 overflow-y-auto py-1">
          {filteredSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Archive className="h-6 w-6 mb-2 text-muted-foreground opacity-40" />
              <p className="text-xs text-muted-foreground opacity-40 pb-10">
                No archived sessions
              </p>
            </div>
          ) : (
            filteredSessions.map((session, index) => (
              <ArchivedSessionItem
                key={session.id}
                session={session}
                index={index}
                isSelected={index === selectedIndex}
                onRestore={handleRestoreSession}
                setRef={handleSetRef}
              />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});
