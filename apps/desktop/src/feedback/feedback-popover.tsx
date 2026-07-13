import { useLanguage } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { Button } from "@chro/ui/button";
import { toast } from "@chro/ui/hooks/use-toast";
import { Popover, PopoverContent, PopoverTrigger } from "@chro/ui/popover";
import { Textarea } from "@chro/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import {
  Bug,
  ChevronLeft,
  Lightbulb,
  Megaphone,
  MessageSquare,
  Send,
  X,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { type FeedbackCategory, submitFeedback } from "./feedback-api";

interface CategoryDescriptor {
  category: FeedbackCategory;
  icon: LucideIcon;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
}

/** Maintainer's X account, surfaced as a follow link in the feedback menu. */
const X_PROFILE_URL = "https://x.com/n_asuy";
const X_HANDLE = "@n_asuy";

const CATEGORIES: CategoryDescriptor[] = [
  {
    category: "feedback",
    icon: Megaphone,
    titleKey: "feedbackMenuGiveTitle",
    descriptionKey: "feedbackMenuGiveDescription",
  },
  {
    category: "bug",
    icon: Bug,
    titleKey: "feedbackMenuBugTitle",
    descriptionKey: "feedbackMenuBugDescription",
  },
  {
    category: "feature",
    icon: Lightbulb,
    titleKey: "feedbackMenuFeatureTitle",
    descriptionKey: "feedbackMenuFeatureDescription",
  },
];

/**
 * Feedback entry point for the window-chrome header, sitting alongside the CLI
 * and Settings controls and mirroring the CLI menu's visual language. Clicking
 * opens a popover that first offers a category (feedback / bug / feature) and
 * then a compose form. Submissions are sent to the cloud API (`apps/api`),
 * which persists them and notifies Slack.
 */
export function FeedbackToggle() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const reset = useCallback(() => {
    setCategory(null);
    setMessage("");
    setSending(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) {
        reset();
      }
    },
    [reset],
  );

  const activeDescriptor = CATEGORIES.find((c) => c.category === category);

  const handleSend = useCallback(async () => {
    if (!category) {
      return;
    }
    const trimmed = message.trim();
    if (trimmed.length === 0 || sending) {
      return;
    }

    setSending(true);
    try {
      await submitFeedback({ category, message: trimmed });
      handleOpenChange(false);
      toast({ description: t("feedbackSuccess") });
    } catch (error) {
      console.error("[feedback] Failed to submit feedback", error);
      setSending(false);
      toast({ description: t("feedbackError"), variant: "destructive" });
    }
  }, [category, message, sending, handleOpenChange, t]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <TooltipProvider delayDuration={120}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t("feedback")}
                className={cn(
                  "ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                  "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                  open && "text-foreground",
                )}
              >
                <MessageSquare className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center">
            {t("feedback")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-80 p-1"
        onOpenAutoFocus={(event) => {
          // The category menu keeps focus on the trigger; the compose step
          // manages its own textarea autofocus.
          if (!category) {
            event.preventDefault();
          }
        }}
      >
        {activeDescriptor ? (
          <ComposeStep
            title={t(activeDescriptor.titleKey)}
            placeholder={t("feedbackComposePlaceholder")}
            backLabel={t("feedbackComposeBack")}
            closeLabel={t("feedbackComposeClose")}
            sendLabel={sending ? t("feedbackSending") : t("feedbackSend")}
            message={message}
            sending={sending}
            onMessageChange={setMessage}
            onBack={() => setCategory(null)}
            onClose={() => handleOpenChange(false)}
            onSend={handleSend}
          />
        ) : (
          <CategoryMenu
            title={t("feedback")}
            closeLabel={t("feedbackComposeClose")}
            followXLabel={t("feedbackFollowX")}
            renderTitle={(descriptor) => t(descriptor.titleKey)}
            renderDescription={(descriptor) => t(descriptor.descriptionKey)}
            onSelect={setCategory}
            onClose={() => handleOpenChange(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

interface CategoryMenuProps {
  title: string;
  closeLabel: string;
  followXLabel: string;
  renderTitle: (descriptor: CategoryDescriptor) => string;
  renderDescription: (descriptor: CategoryDescriptor) => string;
  onSelect: (category: FeedbackCategory) => void;
  onClose: () => void;
}

function CategoryMenu({
  title,
  closeLabel,
  followXLabel,
  renderTitle,
  renderDescription,
  onSelect,
  onClose,
}: CategoryMenuProps) {
  return (
    <div>
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-xs font-medium">{title}</span>
        <IconButton label={closeLabel} onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <Separator />
      {CATEGORIES.map((descriptor) => {
        const Icon = descriptor.icon;
        return (
          <button
            key={descriptor.category}
            type="button"
            onClick={() => onSelect(descriptor.category)}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none",
              "hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-medium leading-tight">
                {renderTitle(descriptor)}
              </span>
              <span className="truncate text-[11px] leading-tight text-muted-foreground">
                {renderDescription(descriptor)}
              </span>
            </span>
          </button>
        );
      })}
      <Separator />
      <a
        href={X_PROFILE_URL}
        target="_blank"
        rel="noreferrer"
        aria-label={followXLabel}
        className={cn(
          "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none",
          "hover:bg-accent hover:text-accent-foreground",
        )}
      >
        <XLogo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs leading-tight">{followXLabel}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {X_HANDLE}
        </span>
      </a>
    </div>
  );
}

/** X (formerly Twitter) wordmark glyph. lucide-react ships no current X logo. */
function XLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.657l-5.214-6.817-5.966 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

interface ComposeStepProps {
  title: string;
  placeholder: string;
  backLabel: string;
  closeLabel: string;
  sendLabel: string;
  message: string;
  sending: boolean;
  onMessageChange: (value: string) => void;
  onBack: () => void;
  onClose: () => void;
  onSend: () => void;
}

function ComposeStep({
  title,
  placeholder,
  backLabel,
  closeLabel,
  sendLabel,
  message,
  sending,
  onMessageChange,
  onBack,
  onClose,
  onSend,
}: ComposeStepProps) {
  const canSend = message.trim().length > 0 && !sending;

  return (
    <div>
      <div className="flex items-center justify-between px-1 py-1">
        <IconButton label={backLabel} onClick={onBack}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </IconButton>
        <span className="text-xs font-medium">{title}</span>
        <IconButton label={closeLabel} onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      <div className="px-1 pb-1">
        <Textarea
          // biome-ignore lint/a11y/noAutofocus: focus belongs on the compose field
          autoFocus
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={placeholder}
          className="min-h-[96px] resize-none text-sm"
        />

        <Button
          type="button"
          size="sm"
          onClick={onSend}
          disabled={!canSend}
          className="mt-2 w-full gap-1.5"
        >
          <Send className="h-3.5 w-3.5" />
          {sendLabel}
        </Button>
      </div>
    </div>
  );
}

function Separator() {
  return <div className="-mx-1 my-1 h-px bg-muted" />;
}

interface IconButtonProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
}

function IconButton({ label, onClick, children }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded",
        "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
