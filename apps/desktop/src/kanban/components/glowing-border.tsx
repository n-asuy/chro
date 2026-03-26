import { useEffect, useId, type ReactNode } from "react";

const glowingBorderStyles = `
@property --hue {
  syntax: "<number>";
  inherits: true;
  initial-value: 0;
}

@property --rotate {
  syntax: "<angle>";
  inherits: false;
  initial-value: 0deg;
}

@keyframes glow-rotate {
  to {
    --rotate: 360deg;
  }
}

@keyframes glow-hue-animation {
  to {
    --hue: 360;
  }
}
`;

export function GlowingBorder({ children }: { children: ReactNode }) {
  const id = useId();
  const styleId = `glow-border-${id.replace(/:/g, "")}`;

  useEffect(() => {
    // Inject global styles once
    if (!document.getElementById("glow-border-global-styles")) {
      const styleEl = document.createElement("style");
      styleEl.id = "glow-border-global-styles";
      styleEl.textContent = glowingBorderStyles;
      document.head.appendChild(styleEl);
    }
  }, []);

  return (
    <div
      className={styleId}
      style={{
        position: "relative",
        borderRadius: "5px",
        zIndex: 0,
      }}
    >
      <style>{`
        .${styleId}::before {
          content: "";
          position: absolute;
          inset: -2px;
          border-radius: inherit;
          z-index: -1;
          background: conic-gradient(
            from var(--rotate),
            hsl(calc(var(--hue)) 95% 75%),
            hsl(calc(var(--hue) + 60) 98% 75%),
            hsl(calc(var(--hue) + 120) 95% 75%),
            hsl(calc(var(--hue) + 180) 98% 75%),
            hsl(calc(var(--hue) + 240) 95% 75%),
            hsl(calc(var(--hue) + 300) 98% 75%),
            hsl(calc(var(--hue) + 360) 95% 75%)
          );
          animation: glow-rotate 4s linear infinite, glow-hue-animation 10s linear infinite;
        }
      `}</style>
      {children}
    </div>
  );
}
