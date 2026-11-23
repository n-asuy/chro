import { useLanguage } from "@/i18n";
import { useEffect, useState } from "react";
import {
  type TalkLanguages,
  fetchTalkLanguages,
} from "../lib/edge-input-client";
import { type EdgeSide, useEdgePrefs } from "../state/edge-prefs";
import type { SettingsPage } from "../state/edge-toolbar-store";
import {
  CheckGlyph,
  ChevronRightGlyph,
  EdgeGlyph,
  ExternalLinkGlyph,
  GearGlyph,
  GlobeGlyph,
  KeyboardGlyph,
  PaletteGlyph,
  PowerGlyph,
  SpeakerGlyph,
} from "./edge-glyphs";
import { usePanelReady } from "./edge-panel-ready";

/** A locale's name in the interface language (ja-JP → 日本語 (日本)). */
export function localeName(id: string, uiLanguage: string): string {
  try {
    const names = new Intl.DisplayNames([uiLanguage], { type: "language" });
    return names.of(id.replace("_", "-")) ?? id;
  } catch {
    return id;
  }
}

/** The talk languages the device recognizes, read once per open. */
function useTalkLanguages(): TalkLanguages | null {
  const [languages, setLanguages] = useState<TalkLanguages | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchTalkLanguages().then((value) => {
      if (alive) setLanguages(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return languages;
}

function useTalkLanguageLabel(languages: TalkLanguages | null): string {
  const { t, language } = useLanguage();
  const chosen = useEdgePrefs((s) => s.talkLanguage);
  if (chosen) return localeName(chosen, language);
  const automatic = languages?.automatic;
  return automatic
    ? t("edgeSettingsAutomaticWith", {
        language: localeName(automatic, language),
      })
    : t("edgeSettingsAutomatic");
}

/**
 * "…" → Settings (the mock's settings menu): the edge's own settings beside
 * the toolbar. Rows with a chevron open their page in the flyout beside it
 * (on pointing, as a native menu does); the last rows act.
 */
export function EdgeSettingsMenu({
  page,
  onPage,
  onOpenChroSettings,
  onTurnOff,
}: {
  page: SettingsPage | null;
  onPage: (page: SettingsPage) => void;
  onOpenChroSettings: () => void;
  onTurnOff: () => void;
}) {
  const { t } = useLanguage();
  const side = useEdgePrefs((s) => s.side);
  const playSounds = useEdgePrefs((s) => s.playSounds);
  const languages = useTalkLanguages();
  const languageLabel = useTalkLanguageLabel(languages);
  usePanelReady(true);

  const row = (
    id: SettingsPage,
    glyph: React.ReactNode,
    label: string,
    value: string,
  ) => (
    <button
      type="button"
      data-edge-hover={`settings:${id}`}
      data-active={page === id ? "" : undefined}
      onClick={() => onPage(id)}
      onPointerEnter={() => onPage(id)}
      className="edge-mrow"
    >
      {glyph}
      <span className="edge-mrow-label">{label}</span>
      <span className="edge-mrow-value">{value}</span>
      <span className="edge-mrow-chev">
        <ChevronRightGlyph />
      </span>
    </button>
  );

  return (
    <section className="edge-menu" data-edge-panel-content>
      <div className="edge-menu-head">
        <GearGlyph />
        <b>{t("edgeToolbarSettings")}</b>
      </div>
      <div className="edge-menu-group">
        {row(
          "look",
          <PaletteGlyph />,
          t("edgeSettingsLook"),
          `${side === "left" ? t("edgeSettingsLeft") : t("edgeSettingsRight")} · ${
            playSounds ? t("edgeSettingsSoundsOn") : t("edgeSettingsSoundsOff")
          }`,
        )}
        {row(
          "language",
          <GlobeGlyph />,
          t("edgeSettingsTalkLanguage"),
          languageLabel,
        )}
      </div>
      <button type="button" onClick={onOpenChroSettings} className="edge-mrow">
        <ExternalLinkGlyph />
        <span className="edge-mrow-label">{t("edgeSettingsOpenChro")}</span>
      </button>
      <button type="button" onClick={onTurnOff} className="edge-mrow">
        <PowerGlyph />
        <span className="edge-mrow-label">{t("edgeSettingsTurnOff")}</span>
      </button>
    </section>
  );
}

function Toggle({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-on={on ? "" : undefined}
      onClick={() => onChange(!on)}
      className="edge-toggle"
    />
  );
}

/** "Edge & sound" (the mock's Look & sound, with only what chro has). */
function LookPage() {
  const { t } = useLanguage();
  const side = useEdgePrefs((s) => s.side);
  const playSounds = useEdgePrefs((s) => s.playSounds);
  const setPref = useEdgePrefs((s) => s.setPref);
  const sides: { id: EdgeSide; label: string }[] = [
    { id: "left", label: t("edgeSettingsLeft") },
    { id: "right", label: t("edgeSettingsRight") },
  ];
  return (
    <section className="edge-menu" data-edge-panel-content>
      <div className="edge-menu-head">
        <PaletteGlyph />
        <b>{t("edgeSettingsLook")}</b>
      </div>
      <div className="edge-menu-section">{t("edgeSettingsEdge")}</div>
      <div className="edge-menu-group">
        <div className="edge-prow">
          <EdgeGlyph />
          <span className="edge-prow-label">{t("edgeSettingsPosition")}</span>
          <span className="edge-seg">
            {sides.map((item) => (
              <button
                key={item.id}
                type="button"
                data-on={side === item.id ? "" : undefined}
                onClick={() => setPref("side", item.id)}
              >
                {item.label}
              </button>
            ))}
          </span>
        </div>
      </div>
      <div className="edge-menu-section">{t("edgeSettingsKeyboard")}</div>
      <div className="edge-menu-group">
        <div className="edge-prow" data-stack="">
          <div className="edge-prow-line">
            <KeyboardGlyph />
            <span className="edge-prow-label">
              {t("edgeSettingsShortcuts")}
            </span>
            <span className="edge-shortcut">
              <kbd>⌥</kbd> x2 · {t("edgeSettingsHold")} <kbd>⌥</kbd>
            </span>
          </div>
          <div className="edge-prow-desc">
            {t("edgeSettingsShortcutsDescription")}
          </div>
        </div>
      </div>
      <div className="edge-menu-section">{t("edgeSettingsSounds")}</div>
      <div className="edge-menu-group">
        <div className="edge-prow">
          <SpeakerGlyph />
          <span className="edge-prow-label">{t("edgeSettingsPlaySounds")}</span>
          <Toggle
            on={playSounds}
            label={t("edgeSettingsPlaySounds")}
            onChange={(on) => setPref("playSounds", on)}
          />
        </div>
      </div>
    </section>
  );
}

/** "Talk language": automatic, or a locale the device recognizes. */
function LanguagePage() {
  const { t, language } = useLanguage();
  const languages = useTalkLanguages();
  const chosen = useEdgePrefs((s) => s.talkLanguage);
  const setPref = useEdgePrefs((s) => s.setPref);
  const automatic = languages?.automatic;
  const option = (id: string | null, label: string, detail?: string) => (
    <button
      key={id ?? "automatic"}
      type="button"
      data-active={chosen === id ? "" : undefined}
      onClick={() => setPref("talkLanguage", id)}
      className="edge-mrow"
    >
      <span className="edge-mrow-label">{label}</span>
      {detail ? <span className="edge-mrow-value">{detail}</span> : null}
      <span className="edge-mrow-tick">
        {chosen === id ? <CheckGlyph /> : null}
      </span>
    </button>
  );
  return (
    <section className="edge-menu" data-edge-panel-content>
      <div className="edge-menu-head">
        <GlobeGlyph />
        <b>{t("edgeSettingsTalkLanguage")}</b>
      </div>
      <div className="edge-menu-group edge-menu-scroll">
        {option(
          null,
          t("edgeSettingsAutomatic"),
          automatic ? localeName(automatic, language) : undefined,
        )}
        {(languages?.locales ?? []).map((id) =>
          option(id, localeName(id, language)),
        )}
      </div>
      <div className="edge-prow-desc edge-menu-foot">
        {t("edgeSettingsTalkLanguageDescription")}
      </div>
    </section>
  );
}

/** The flyout beside the menu: the page a row opened. */
export function EdgeSettingsPage({ page }: { page: SettingsPage }) {
  usePanelReady(true);
  return page === "look" ? <LookPage /> : <LanguagePage />;
}
