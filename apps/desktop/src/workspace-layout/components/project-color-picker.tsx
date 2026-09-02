import type { TranslationFunction } from "@/i18n";
import { cn } from "@/lib/cn";
import {
  PROJECT_COLOR_NAMES,
  hsvToHex,
  isProjectColorName,
  projectBadgeColor,
  projectColorValue,
} from "@/session/domain/project-color";
import { useRef, useState } from "react";

/**
 * Color picker body for the project context menu: preset swatch row, a
 * hue/value field with a saturation slider for custom picks, and a clear row
 * that removes the color (no dot).
 *
 * Presets are stored by name so they stay theme-aware; field picks are stored
 * as concrete hex. The saturation slider deliberately clamps into a soft band
 * so custom colors stay in the same family as the presets.
 */
export function ProjectColorPicker({
  badgeColor,
  onChange,
  t,
}: {
  badgeColor: string | null;
  onChange: (badgeColor: string | null) => void;
  t: TranslationFunction;
}) {
  // Last field pick, kept so the saturation slider can re-derive the hex
  // without another field click. Defaults roughly match the purple preset.
  const lastPickRef = useRef({ h: 265, v: 0.62 });
  const [saturation, setSaturation] = useState(55);
  const fieldRef = useRef<HTMLDivElement>(null);

  const applyFieldPick = (nextSaturation: number) => {
    const { h, v } = lastPickRef.current;
    const s = 0.3 + (nextSaturation / 100) * 0.45;
    onChange(hsvToHex(h, s, v));
  };

  const handleFieldPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = fieldRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
    lastPickRef.current = {
      h: (x / rect.width) * 360,
      v: 0.92 - (y / rect.height) * 0.62,
    };
    applyFieldPick(saturation);
  };

  const isCustom = Boolean(badgeColor) && !isProjectColorName(badgeColor ?? "");

  return (
    <div className="w-60 p-2">
      <div className="flex items-center gap-[5px] pb-2">
        {PROJECT_COLOR_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            aria-label={name}
            aria-pressed={badgeColor === name}
            onClick={() => onChange(name)}
            className={cn(
              "h-[18px] w-[18px] shrink-0 rounded-full outline-none transition-shadow",
              badgeColor === name
                ? "ring-2 ring-custom-text-200 ring-offset-2 ring-offset-custom-background-100"
                : "hover:ring-1 hover:ring-custom-text-400 hover:ring-offset-2 hover:ring-offset-custom-background-100",
            )}
            style={{ backgroundColor: projectColorValue(name) }}
          />
        ))}
      </div>

      <div
        ref={fieldRef}
        onPointerDown={handleFieldPointer}
        role="presentation"
        className="relative h-24 cursor-crosshair overflow-hidden rounded-lg"
        style={{
          background:
            "linear-gradient(to bottom, rgba(255,255,255,.92), rgba(255,255,255,0) 42%)," +
            "linear-gradient(to bottom, rgba(0,0,0,0) 55%, rgba(0,0,0,.82))," +
            "linear-gradient(to right, #d94a44, #d9a13c, #cfd23c, #58c04f, #3fc0ae, #4478d9, #8a4fd0, #cf4fb4, #d94a44)",
        }}
      />

      <div className="flex items-center gap-2.5 pt-2.5">
        <span className="w-9 shrink-0 text-xs text-custom-text-300">
          {t("projectColorSaturation")}
        </span>
        <input
          type="range"
          min={10}
          max={100}
          value={saturation}
          onChange={(event) => {
            const next = Number(event.target.value);
            setSaturation(next);
            if (isCustom) applyFieldPick(next);
          }}
          className="h-1 flex-1 accent-custom-primary-100"
        />
      </div>

      <div className="mt-2.5 flex items-center justify-between border-custom-border-100 border-t pt-2">
        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={badgeColor === null}
          className="text-[11.5px] text-custom-text-300 transition-colors hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40"
        >
          {t("projectColorClear")}
        </button>
        <span className="flex items-center gap-1.5 text-[11.5px] text-custom-text-400">
          {badgeColor ? (
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full"
              style={{
                backgroundColor: projectBadgeColor(badgeColor) ?? undefined,
              }}
            />
          ) : null}
          {isCustom ? badgeColor : null}
        </span>
      </div>
    </div>
  );
}
