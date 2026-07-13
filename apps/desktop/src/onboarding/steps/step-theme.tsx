import type { AppTheme } from "@/lib/preferences-client";
import { useAppearanceConfigStore } from "@/settings/state/appearance-store";
import { Check } from "lucide-react";

type ThemeTile = {
  value: AppTheme;
  label: string;
  /** Preview swatch colors (surface, line, accent bar). */
  surface: string;
  line: string;
  accent: string;
  darkText?: boolean;
};

// Preview colors mirror the real light/dark surface + azure primary tokens from
// globals.css so the swatch reads as the actual theme, not an arbitrary sample.
const TILES: ThemeTile[] = [
  {
    value: "dark",
    label: "Dark",
    surface: "#1c1d21",
    line: "#2b2d31",
    accent: "#4ba3ec",
  },
  {
    value: "light",
    label: "Light",
    surface: "#ffffff",
    line: "#e6e8ec",
    accent: "#1b75c2",
    darkText: true,
  },
  {
    value: "system",
    label: "System",
    surface: "#0d0e10",
    line: "#26272c",
    accent: "#4ba3ec",
  },
];

/**
 * Onboarding step 2: appearance. Selecting a tile persists the theme through the
 * appearance store, which applies `data-theme` on the next frame, so the whole
 * app previews the choice instantly.
 */
export function StepTheme() {
  const theme = useAppearanceConfigStore((s) => s.config.theme);
  const update = useAppearanceConfigStore((s) => s.update);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {TILES.map((tile) => {
          const selected = theme === tile.value;
          return (
            <button
              key={tile.value}
              type="button"
              onClick={() => void update({ theme: tile.value })}
              className={`overflow-hidden rounded-lg border text-left transition-colors ${
                selected
                  ? "border-primary"
                  : "border-custom-border-200 hover:border-custom-border-300"
              }`}
            >
              <div
                className="flex h-24 flex-col gap-1.5 p-3"
                style={{ background: tile.surface }}
              >
                <div
                  className="h-2 w-3/5 rounded"
                  style={{ background: tile.line }}
                />
                <div
                  className="h-2 w-2/5 rounded"
                  style={{ background: tile.line }}
                />
                <div
                  className="mt-auto h-5 w-4/5 rounded"
                  style={{ background: tile.accent }}
                />
              </div>
              <div
                className="flex items-center justify-between border-t border-custom-border-200 px-3 py-2 text-[13px] font-medium"
                style={
                  tile.darkText
                    ? { background: "#f6f7f9", color: "#17181b" }
                    : undefined
                }
              >
                <span>{tile.label}</span>
                {selected ? (
                  <Check className="size-3.5 text-primary" />
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-center text-xs text-muted-foreground">
        You can fine-tune every color later in Settings → Appearance.
      </p>
    </div>
  );
}
