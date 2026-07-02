import { cn } from "@/lib/cn";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { TextShimmer } from "./text-shimmer";

/**
 * Chain-of-thought timeline for agent working steps, ported from
 * fluidfunctionalism.com's thinking-steps component: a collapsible header
 * followed by steps connected with a vertical line in the icon column.
 * Adapted to chro's stack — framer-motion only (no Radix accordion), lucide
 * icons passed directly, and TextShimmer for the active state.
 */

const SPRING_FAST = { type: "spring", duration: 0.08, bounce: 0 } as const;
const SPRING_TOGGLE = { type: "spring", duration: 0.16, bounce: 0 } as const;
const SPRING_STEP = { type: "spring", duration: 0.24, bounce: 0.1 } as const;

type ThinkingStepsProps = {
  label: string;
  /** Agent is still working: shimmer the header label. */
  active?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
};

export const ThinkingSteps = ({
  label,
  active = false,
  open,
  onOpenChange,
  children,
  className,
}: ThinkingStepsProps) => {
  return (
    <div className={cn("w-full", className)}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className={cn(
          "group/steps flex w-fit min-w-0 max-w-full cursor-pointer select-none items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors",
          "hover:bg-custom-sidebar-background-80",
          open ? "font-medium text-foreground" : "text-muted-foreground",
          "hover:text-foreground",
        )}
      >
        {active ? (
          <TextShimmer
            as="span"
            className="min-w-0 truncate text-[13px] font-medium"
          >
            {label}
          </TextShimmer>
        ) : (
          <span className="min-w-0 truncate">{label}</span>
        )}
        <motion.span
          className="inline-flex shrink-0 items-center justify-center"
          animate={{ rotate: open ? 90 : 0 }}
          transition={SPRING_FAST}
        >
          <ChevronRight
            size={14}
            strokeWidth={open ? 2 : 1.5}
            className="text-muted-foreground transition-colors group-hover/steps:text-foreground"
          />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="overflow-hidden"
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            transition={SPRING_TOGGLE}
          >
            <div className="flex flex-col pt-1">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

type ThinkingStepProps = {
  /** Icon shown in the timeline column; defaults to a small dot. */
  icon?: ReactNode;
  /** Animate the step in on mount (used while a run is streaming). */
  animateIn?: boolean;
  isLast?: boolean;
  children: ReactNode;
  className?: string;
};

export const ThinkingStep = ({
  icon,
  animateIn = false,
  isLast = false,
  children,
  className,
}: ThinkingStepProps) => {
  return (
    /* Outer animates height to open space, inner fades content in after. */
    <motion.div
      className={cn("relative overflow-hidden", className)}
      initial={animateIn ? { height: 0 } : false}
      animate={{ height: "auto" }}
      transition={SPRING_STEP}
    >
      <motion.div
        initial={animateIn ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.24, delay: 0.08, ease: "easeOut" }}
      >
        <div className="flex gap-2.5 px-2 py-1.5">
          {/* Icon column with continuous connector line */}
          <div className="flex w-[14px] shrink-0 flex-col items-center">
            <div className="flex h-[18px] items-center text-muted-foreground">
              {icon ?? (
                <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
              )}
            </div>
            {!isLast && <div className="mt-1 w-px flex-1 bg-border/60" />}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-px">
            {children}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};
