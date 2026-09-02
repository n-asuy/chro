import { cn } from "@chro/ui/utils";
import { motion } from "framer-motion";
import type React from "react";
import { type JSX, useMemo } from "react";

interface TextShimmerProps {
  children: string;
  as?: React.ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

export function TextShimmer({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) {
  // `motion(Component)` must be memoized: creating it during render returns a
  // new component type every render, which remounts the motion element and, via
  // framer-motion's internal state updates, drives an infinite re-render loop
  // (surfaces as "Maximum update depth exceeded" when this shimmer is mounted,
  // e.g. the streaming "loading" entry while a task run is being cancelled).
  const MotionComponent = useMemo(
    () => motion(Component as keyof JSX.IntrinsicElements),
    [Component],
  );

  const dynamicSpread = useMemo(() => {
    return children.length * spread;
  }, [children, spread]);

  return (
    <MotionComponent
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text",
        "text-transparent [--base-color:#a1a1aa] [--base-gradient-color:#000]",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        "dark:[--base-color:#71717a] dark:[--base-gradient-color:#ffffff] dark:[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]",
        className,
      )}
      initial={{ backgroundPosition: "100% center" }}
      animate={{ backgroundPosition: "0% center" }}
      transition={{
        repeat: Number.POSITIVE_INFINITY,
        duration,
        ease: "linear",
      }}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--base-color), var(--base-color))",
        } as React.CSSProperties
      }
    >
      {children}
    </MotionComponent>
  );
}
