import { useLanguage } from "@/i18n";
import { Button } from "@chro/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { Input } from "@chro/ui/input";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsRow } from "../components/settings-row";
import { SettingsSection } from "../components/settings-section";
import { useTerminalConfigStore } from "../state/terminal-config-store";

const FONT_SIZE_OPTIONS = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24];
const LINE_HEIGHT_OPTIONS = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0];

export function TerminalPane() {
  const { t } = useLanguage();
  const config = useTerminalConfigStore((s) => s.config);
  const loaded = useTerminalConfigStore((s) => s.loaded);
  const load = useTerminalConfigStore((s) => s.load);
  const update = useTerminalConfigStore((s) => s.update);

  const [familyDraft, setFamilyDraft] = useState(config.font_family ?? "");

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [loaded, load]);

  // Keep the input in sync with the persisted value (initial load, external
  // changes). Keyed on the primitive so it never clobbers in-progress typing.
  useEffect(() => {
    setFamilyDraft(config.font_family ?? "");
  }, [config.font_family]);

  const commitFamily = () => {
    const trimmed = familyDraft.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next === config.font_family) {
      return;
    }
    void update({ font_family: next });
  };

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="font-workspace text-[20px] font-bold text-foreground">
          {t("terminalSettingsTitle")}
        </h2>
        <p className="font-workspace text-[13px] text-muted-foreground mt-1">
          {t("terminalSettingsDescription")}
        </p>
      </div>

      <SettingsSection>
        <SettingsRow
          title={t("terminalFontFamilyTitle")}
          description={t("terminalFontFamilyDescription")}
        >
          <Input
            value={familyDraft}
            placeholder={t("terminalFontFamilyPlaceholder")}
            onChange={(event) => setFamilyDraft(event.target.value)}
            onBlur={commitFamily}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            className="font-workspace mt-1 h-9 text-[13px]"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsRow
          title={t("terminalFontSizeTitle")}
          description={t("terminalFontSizeDescription")}
          control={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="font-workspace text-[13px] flex h-9 min-w-[100px] items-center justify-between rounded-lg border border-border/40 bg-custom-background-90 px-3 text-foreground transition hover:border-border/60 hover:bg-custom-background-80 focus-visible:ring-1 focus-visible:ring-primary data-[state=open]:border-primary/60"
                >
                  <span className="tabular-nums">{config.font_size}px</span>
                  <ChevronDown className="h-4 w-4 text-current" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-[120px] rounded-lg border border-border/50 bg-custom-background-100 p-1"
              >
                {FONT_SIZE_OPTIONS.map((size) => {
                  const isActive = config.font_size === size;
                  return (
                    <DropdownMenuItem
                      key={size}
                      onClick={() => void update({ font_size: size })}
                      className="font-workspace cursor-pointer rounded px-2 py-1.5 text-[13px] text-foreground"
                    >
                      <div className="flex w-full items-center justify-between">
                        <span className="tabular-nums">{size}px</span>
                        {isActive ? <Check className="h-4 w-4" /> : null}
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <SettingsRow
          title={t("terminalLineHeightTitle")}
          description={t("terminalLineHeightDescription")}
          control={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="font-workspace text-[13px] flex h-9 min-w-[100px] items-center justify-between rounded-lg border border-border/40 bg-custom-background-90 px-3 text-foreground transition hover:border-border/60 hover:bg-custom-background-80 focus-visible:ring-1 focus-visible:ring-primary data-[state=open]:border-primary/60"
                >
                  <span className="tabular-nums">
                    {config.line_height.toFixed(1)}
                  </span>
                  <ChevronDown className="h-4 w-4 text-current" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-[120px] rounded-lg border border-border/50 bg-custom-background-100 p-1"
              >
                {LINE_HEIGHT_OPTIONS.map((lh) => {
                  const isActive =
                    config.line_height.toFixed(1) === lh.toFixed(1);
                  return (
                    <DropdownMenuItem
                      key={lh}
                      onClick={() => void update({ line_height: lh })}
                      className="font-workspace cursor-pointer rounded px-2 py-1.5 text-[13px] text-foreground"
                    >
                      <div className="flex w-full items-center justify-between">
                        <span className="tabular-nums">{lh.toFixed(1)}</span>
                        {isActive ? <Check className="h-4 w-4" /> : null}
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      </SettingsSection>
    </section>
  );
}
