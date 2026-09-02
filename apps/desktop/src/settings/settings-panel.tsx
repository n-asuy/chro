import {
  type SupportedLanguage,
  type TranslationFunction,
  type TranslationKey,
  useLanguage,
} from "@/i18n";
import { cn } from "@/lib/cn";
import { getVersion } from "@/lib/desktop-bridge";
import type { BaseCodingAgent } from "@/lib/executor-client";
import { setUiValue } from "@/lib/ui-state-client";
import { Alert, AlertDescription, AlertTitle } from "@chro/ui/alert";
import { Badge } from "@chro/ui/badge";
import { Button } from "@chro/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@chro/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { Label } from "@chro/ui/label";
import { Switch } from "@chro/ui/switch";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  FolderOpen,
  Loader2,
  RefreshCcw,
  Save,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { BetaFeaturesSection } from "./components/beta-features-section";
import { SettingsRow } from "./components/settings-row";
import { SettingsSection } from "./components/settings-section";
import { useAgentCliStatus } from "./hooks/use-agent-cli-status";
import { useExecutorProfileSettings } from "./hooks/use-executor-profile-settings";
import { useMcpSettings } from "./hooks/use-mcp-settings";
import { useMergeSettings } from "./hooks/use-merge-settings";
import { usePreferencesSettings } from "./hooks/use-preferences-settings";
import { useWorktreeSettings } from "./hooks/use-worktree-settings";
import { AppearancePane } from "./panes/appearance-pane";
import { NotificationsPane } from "./panes/notifications-pane";
import { PiApiKeysControl } from "./pi-api-keys-control";
import { useEditorConfigStore } from "./state/editor-config-store";

type LanguageOption = SupportedLanguage;

const LANGUAGE_OPTIONS: Array<{
  value: LanguageOption;
  label: string;
  flag: string;
}> = [
  { value: "en", label: "English", flag: "🇺🇸" },
  { value: "ja", label: "日本語", flag: "🇯🇵" },
];

const DEFAULT_MCP_EXECUTORS: BaseCodingAgent[] = ["CLAUDE_CODE", "CODEX"];
const MCP_STATUS_SUPPORTED_EXECUTORS: BaseCodingAgent[] = [
  ...DEFAULT_MCP_EXECUTORS,
];

const MCP_EXECUTOR_LABEL_KEYS: Record<BaseCodingAgent, TranslationKey> = {
  CLAUDE_CODE: "mcpExecutorOptionClaude",
  CODEX: "mcpExecutorOptionCodex",
  PI: "mcpExecutorOptionPi",
};

const AGENT_CLI_ORDER: BaseCodingAgent[] = ["CLAUDE_CODE", "CODEX", "PI"];
const AGENT_CLI_NAMES: Record<BaseCodingAgent, string> = {
  CLAUDE_CODE: "claude",
  CODEX: "codex",
  PI: "pi",
};

type SettingsTabKey =
  | "general"
  | "appearance"
  | "workspace"
  | "editor"
  | "notifications"
  | "mcp"
  | "agents"
  | "developer";

type SettingsNavItem = {
  key: SettingsTabKey;
  label: string;
};

type SettingsPanelVariant = "page" | "modal";

type SettingsPanelProps = {
  variant?: SettingsPanelVariant;
  className?: string;
};

const McpJsonEditor = lazy(() => import("./mcp-json-editor"));

type AppVersionStatus = "loading" | "ready" | "unavailable" | "error";

const formatAppVersion = (version: string) =>
  version.startsWith("v") ? version : `v${version}`;

export function SettingsPanel({
  variant = "page",
  className,
}: SettingsPanelProps) {
  const {
    language: activeLanguage,
    setLanguage: setAppLanguage,
    t,
  } = useLanguage();
  const [activeTab, setActiveTab] = useState<SettingsTabKey>("general");
  const [appVersionStatus, setAppVersionStatus] =
    useState<AppVersionStatus>("loading");
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const {
    language,
    showHiddenEntries,
    analyticsEnabled,
    preferencesLoading,
    preferencesError,
    preferencesParseWarning,
    preferencesSaveState,
    preferencesSaveError,
    handleLanguageSelect,
    handleHiddenToggle,
    handleAnalyticsToggle,
  } = usePreferencesSettings({
    activeLanguage,
    setAppLanguage,
    t,
  });
  const {
    executorProfileId,
    executorProfileLoading,
    executorProfileError,
    profileSaving,
    availableExecutors,
    handleExecutorSelect,
  } = useExecutorProfileSettings({ t });
  const {
    statuses: agentCliStatuses,
    loading: agentCliStatusesLoading,
    error: agentCliStatusesError,
    reload: reloadAgentCliStatuses,
  } = useAgentCliStatus(activeTab === "agents");
  const {
    configPath,
    configContent,
    isDirty,
    mcpTargetExecutor,
    mcpConfig,
    mcpLoading,
    loadError,
    validationError,
    parseWarning,
    saveState,
    saveError,
    mcpStatusResult,
    mcpStatusLoading,
    mcpStatusError,
    mcpStatusCheckedAtLabel,
    mcpStatusSupported,
    handleMcpTargetSelect,
    handleContentChange,
    handleSave,
    handleReload,
    loadMcpStatus,
  } = useMcpSettings({
    defaultExecutor: DEFAULT_MCP_EXECUTORS[0],
    executorProfileId,
    supportedExecutors: MCP_STATUS_SUPPORTED_EXECUTORS,
    t,
  });
  const {
    mergeCommitTemplate,
    mergeSettingsLoading,
    mergeSettingsError,
    mergeSettingsSaveState,
    mergeSettingsSaveError,
    handleTemplateChange,
    handleTemplateBlur,
    handleTemplateReset,
  } = useMergeSettings({ t });

  const editorConfig = useEditorConfigStore((s) => s.config);
  const editorConfigLoaded = useEditorConfigStore((s) => s.loaded);
  const loadEditorConfig = useEditorConfigStore((s) => s.load);
  const updateEditorConfig = useEditorConfigStore((s) => s.update);

  const {
    worktreeInfo,
    worktreeLoading,
    worktreeError,
    worktreeSizes,
    worktreeTotalSize,
    worktreeSizesLoading,
    worktreeCleanupState,
    worktreeCleanupResult,
    selectedPaths,
    loadWorktreeInfo,
    handleCleanupAllWorktrees,
    handleCleanupSingleWorktree,
    handleCleanupSelectedWorktrees,
    toggleSelection,
    toggleSelectAll,
    clearSelection,
    formatBytes,
  } = useWorktreeSettings({ t });

  const languageLabelId = "display-language-label";
  const selectedLanguageOption = useMemo(
    () => LANGUAGE_OPTIONS.find((option) => option.value === language),
    [language],
  );
  const selectedMcpExecutorLabel = useMemo(
    () => t(MCP_EXECUTOR_LABEL_KEYS[mcpTargetExecutor]),
    [mcpTargetExecutor, t],
  );
  const appVersionLabel = useMemo(() => {
    if (appVersionStatus === "ready" && appVersion) {
      return formatAppVersion(appVersion);
    }
    if (appVersionStatus === "unavailable") {
      return t("appVersionUnavailable");
    }
    if (appVersionStatus === "error") {
      return t("appVersionLoadError");
    }
    return t("loadingMessage");
  }, [appVersion, appVersionStatus, t]);

  const mcpExecutorOptions = useMemo(() => {
    const base = availableExecutors.length
      ? availableExecutors
      : DEFAULT_MCP_EXECUTORS;
    const merged = [...base, ...DEFAULT_MCP_EXECUTORS];
    return Array.from(new Set(merged)) as BaseCodingAgent[];
  }, [availableExecutors]);

  // Load editor config when editor tab is activated
  useEffect(() => {
    if (activeTab === "editor" && !editorConfigLoaded) {
      void loadEditorConfig();
    }
  }, [activeTab, editorConfigLoaded, loadEditorConfig]);

  // Load worktree info when developer tab is activated
  useEffect(() => {
    if (activeTab === "developer" && !worktreeInfo && !worktreeLoading) {
      void loadWorktreeInfo();
    }
  }, [activeTab, worktreeInfo, worktreeLoading, loadWorktreeInfo]);

  useEffect(() => {
    let cancelled = false;
    const fallbackVersion =
      typeof __APP_VERSION__ === "string" && __APP_VERSION__.trim().length > 0
        ? __APP_VERSION__.trim()
        : null;

    const loadAppVersion = async () => {
      const getDesktopVersion = getVersion();
      if (!getDesktopVersion) {
        if (!cancelled) {
          if (fallbackVersion) {
            setAppVersion(fallbackVersion);
            setAppVersionStatus("ready");
          } else {
            setAppVersionStatus("unavailable");
          }
        }
        return;
      }

      if (!cancelled) {
        setAppVersionStatus("loading");
      }
      try {
        const version = await getDesktopVersion();
        if (!cancelled) {
          setAppVersion(version);
          setAppVersionStatus("ready");
        }
      } catch (error) {
        console.error("[settings] Failed to get app version", error);
        if (!cancelled) {
          if (fallbackVersion) {
            setAppVersion(fallbackVersion);
            setAppVersionStatus("ready");
          } else {
            setAppVersionStatus("error");
          }
        }
      }
    };

    void loadAppVersion();
    return () => {
      cancelled = true;
    };
  }, []);

  const navItems = useMemo<SettingsNavItem[]>(
    () => [
      {
        key: "general" as const,
        label: t("settingsTabsGeneral"),
      },
      {
        key: "appearance" as const,
        label: t("settingsTabsAppearance"),
      },
      {
        key: "workspace" as const,
        label: t("settingsTabsWorkspace"),
      },
      {
        key: "editor" as const,
        label: t("settingsTabsEditor"),
      },
      {
        key: "notifications" as const,
        label: t("settingsTabsNotifications"),
      },
      {
        key: "mcp" as const,
        label: t("settingsTabsMcp"),
      },
      {
        key: "agents" as const,
        label: t("settingsTabsAgents"),
      },
      {
        key: "developer" as const,
        label: t("settingsTabsDeveloper"),
      },
    ],
    [t],
  );
  const isModal = variant === "modal";

  const shouldShowPreferencesAlerts = Boolean(
    preferencesError ||
      preferencesParseWarning ||
      (preferencesSaveState === "error" && preferencesSaveError),
  );

  const preferencesAlerts = shouldShowPreferencesAlerts ? (
    <div className="flex flex-col gap-2">
      {preferencesError ? (
        <Alert
          variant="destructive"
          className="border-destructive/30 bg-destructive/10"
        >
          <AlertTitle>{t("preferencesLoadErrorTitle")}</AlertTitle>
          <AlertDescription>{preferencesError}</AlertDescription>
        </Alert>
      ) : null}

      {preferencesParseWarning ? (
        <Alert className="border-amber-300/60 bg-amber-50 text-amber-900">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("parseWarningTitle")}</AlertTitle>
          <AlertDescription>
            {preferencesParseWarning ?? t("parseWarningDescription")}
          </AlertDescription>
        </Alert>
      ) : null}

      {preferencesSaveState === "error" && preferencesSaveError ? (
        <Alert
          variant="destructive"
          className="border-destructive/30 bg-destructive/10"
        >
          <AlertTitle>{t("preferencesSaveErrorTitle")}</AlertTitle>
          <AlertDescription>{preferencesSaveError}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  ) : null;

  const preferencesLoadingIndicator = preferencesLoading ? (
    <div className="font-workspace flex items-center justify-center gap-2 border border-dashed border-border/60 bg-custom-background-90 p-3 text-[11px] text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {t("loadingMessage")}
    </div>
  ) : null;

  const generalSection = (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="font-workspace text-[20px] font-bold text-foreground">
          {t("settingsTabsGeneral")}
        </h2>
      </div>

      {preferencesAlerts}

      <SettingsSection>
        <SettingsRow
          title={t("languageCardTitle")}
          description={t("languageCardDescription")}
          disabled={preferencesLoading || preferencesSaveState === "saving"}
          control={
            <>
              <Label id={languageLabelId} className="sr-only">
                {t("languageFieldLabel")}
              </Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    id="display-language"
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={
                      preferencesLoading || preferencesSaveState === "saving"
                    }
                    aria-labelledby={languageLabelId}
                    className="font-workspace text-[13px] flex h-9 min-w-[160px] items-center justify-between rounded-lg border border-border/40 bg-custom-background-90 px-3 text-foreground transition hover:border-border/60 hover:bg-custom-background-80 focus-visible:ring-1 focus-visible:ring-primary data-[state=open]:border-primary/60 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="truncate">
                      {selectedLanguageOption?.label ??
                        t("languagePlaceholder")}
                    </span>
                    <ChevronDown className="h-4 w-4 text-current" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-48 rounded-lg border border-border/50 bg-custom-background-100 p-1"
                >
                  <DropdownMenuLabel className="font-workspace px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("languageFieldLabel")}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator className="mx-1 my-0.5 bg-border/60" />
                  {LANGUAGE_OPTIONS.map((option) => {
                    const isActive = option.value === language;
                    return (
                      <DropdownMenuItem
                        key={option.value}
                        onClick={() => handleLanguageSelect(option.value)}
                        className="font-workspace cursor-pointer rounded px-2 py-1.5 text-[13px] text-foreground"
                      >
                        <div className="flex w-full items-center justify-between">
                          <span>{option.label}</span>
                          {isActive ? <Check className="h-4 w-4" /> : null}
                        </div>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />
        <SettingsRow
          title={t("appVersionCardTitle")}
          description={t("appVersionCardDescription")}
          control={
            appVersionStatus === "loading" ? (
              <div className="font-workspace flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("loadingMessage")}
              </div>
            ) : (
              <code className="font-mono text-[12px] text-foreground">
                {appVersionLabel}
              </code>
            )
          }
        />
      </SettingsSection>

      <BetaFeaturesSection />

      {preferencesLoadingIndicator}
    </section>
  );

  const workspaceSection = (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="font-workspace text-[20px] font-bold text-foreground">
          {t("settingsTabsWorkspace")}
        </h2>
      </div>

      {preferencesAlerts}

      <SettingsSection>
        <SettingsRow
          title={t("hiddenFilesCardTitle")}
          description={t("hiddenFilesCardDescription")}
          disabled={preferencesLoading || preferencesSaveState === "saving"}
          control={
            <Switch
              checked={showHiddenEntries}
              onCheckedChange={handleHiddenToggle}
              disabled={preferencesLoading || preferencesSaveState === "saving"}
              aria-label={t("hiddenFilesToggleLabel")}
            />
          }
        />
        <SettingsRow
          title={t("analyticsCardTitle")}
          description={t("analyticsCardDescription")}
          disabled={preferencesLoading || preferencesSaveState === "saving"}
          control={
            <Switch
              checked={analyticsEnabled}
              onCheckedChange={handleAnalyticsToggle}
              disabled={preferencesLoading || preferencesSaveState === "saving"}
              aria-label={t("analyticsToggleLabel")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection heading={t("mergeCommitTemplateTitle")}>
        <SettingsRow
          title={t("mergeCommitTemplateTitle")}
          description={t("mergeCommitTemplateDescription")}
          disabled={mergeSettingsLoading}
          control={
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px]"
              onClick={handleTemplateReset}
              disabled={
                mergeSettingsLoading || mergeSettingsSaveState === "saving"
              }
            >
              {t("mergeCommitTemplateResetLabel")}
            </Button>
          }
        >
          <div className="flex flex-col gap-1.5">
            <textarea
              className="font-workspace min-h-[72px] w-full resize-y rounded-lg border border-border/40 bg-custom-background-90 px-3 py-2 text-[12px] text-foreground placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none"
              value={mergeCommitTemplate}
              onChange={(e) => handleTemplateChange(e.target.value)}
              onBlur={handleTemplateBlur}
              placeholder={t("mergeCommitTemplatePlaceholder")}
              disabled={
                mergeSettingsLoading || mergeSettingsSaveState === "saving"
              }
              spellCheck={false}
            />
            {mergeSettingsSaveState === "success" ? (
              <div className="font-workspace flex items-center gap-1 text-[11px] text-emerald-600">
                <Check className="h-3 w-3" />
                <span>Saved</span>
              </div>
            ) : null}
            {mergeSettingsSaveState === "error" && mergeSettingsSaveError ? (
              <p className="font-workspace text-[11px] text-destructive">
                {mergeSettingsSaveError}
              </p>
            ) : null}
            {mergeSettingsError ? (
              <p className="font-workspace text-[11px] text-destructive">
                {mergeSettingsError}
              </p>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      {preferencesLoadingIndicator}
    </section>
  );
  const mcpSection = (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="font-workspace text-[20px] font-bold text-foreground">
          {t("settingsTabsMcp")}
        </h2>
        <p className="font-workspace text-[13px] text-muted-foreground mt-1">
          {t("mcpJsonCardDescription")}
        </p>
      </div>

      {loadError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("mcpLoadErrorTitle")}</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      {parseWarning ? (
        <Alert className="border-amber-300/70 bg-amber-50 text-amber-900">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("parseWarningTitle")}</AlertTitle>
          <AlertDescription>{parseWarning}</AlertDescription>
        </Alert>
      ) : null}

      {saveState === "error" && saveError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("preferencesSaveErrorTitle")}</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection heading={t("mcpTargetAgentLabel")}>
        <SettingsRow
          title={t("mcpTargetAgentLabel")}
          description={t("mcpTargetAgentDescription")}
          control={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="font-workspace flex h-9 min-w-[180px] items-center justify-between rounded-lg border border-border/40 bg-custom-background-90 px-3 text-[13px] text-foreground transition hover:border-border/60 hover:bg-custom-background-80 focus-visible:ring-1 focus-visible:ring-primary"
                >
                  <span className="truncate">{selectedMcpExecutorLabel}</span>
                  <ChevronDown className="h-4 w-4 text-current" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-[220px] rounded-lg border border-border/50 bg-custom-background-100 p-1"
              >
                <DropdownMenuLabel className="font-workspace px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("mcpTargetAgentLabel")}
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="mx-1 my-0.5 bg-border/60" />
                {mcpExecutorOptions.map((option) => {
                  const isActive = option === mcpTargetExecutor;
                  return (
                    <DropdownMenuItem
                      key={option}
                      onClick={() => handleMcpTargetSelect(option)}
                      className="font-workspace cursor-pointer rounded px-2 py-1.5 text-[13px] text-foreground"
                    >
                      <div className="flex w-full items-center justify-between">
                        <span>{t(MCP_EXECUTOR_LABEL_KEYS[option])}</span>
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

      {/* MCP Status */}
      <SettingsSection
        heading={t("mcpStatusCardTitle")}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadMcpStatus()}
            disabled={mcpStatusLoading || !mcpStatusSupported}
            className="font-workspace gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            {mcpStatusLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" />
            )}
            {mcpStatusLoading
              ? t("mcpStatusChecking")
              : t("mcpStatusCheckButton")}
          </Button>
        }
      >
        {mcpStatusError ? (
          <div className="px-5 py-4">
            <Alert
              variant="destructive"
              className="border-destructive/40 bg-destructive/10"
            >
              <AlertDescription className="text-[12px]">
                {mcpStatusError}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {!mcpStatusSupported ? (
          <div className="px-5 py-4">
            <p className="font-workspace text-[12px] text-muted-foreground">
              {t("mcpStatusClaudeOnly", { agent: selectedMcpExecutorLabel })}
            </p>
          </div>
        ) : null}

        {mcpStatusResult &&
        mcpStatusResult.servers.length === 0 &&
        !mcpStatusError ? (
          <div className="px-5 py-4">
            <p className="font-workspace text-[12px] text-muted-foreground">
              {t("mcpStatusNoServers")}
            </p>
          </div>
        ) : null}

        {mcpStatusResult && mcpStatusResult.servers.length > 0
          ? mcpStatusResult.servers.map((server) => (
              <div
                key={server.name}
                className="flex items-center justify-between px-5 py-4"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="font-workspace text-[13px] font-medium text-foreground">
                    {server.name}
                  </span>
                </div>
                <Badge
                  variant={server.connected ? "default" : "secondary"}
                  className={cn(
                    "font-workspace text-[11px]",
                    server.connected
                      ? "bg-emerald-500/20 text-emerald-600 border-emerald-500/40"
                      : "bg-muted text-muted-foreground border-muted-foreground/40",
                  )}
                >
                  {server.connected
                    ? t("mcpStatusConnected")
                    : t("mcpStatusDisconnected")}
                </Badge>
              </div>
            ))
          : null}

        {mcpStatusCheckedAtLabel ? (
          <div className="px-5 py-3">
            <p className="font-workspace text-[11px] text-muted-foreground">
              {t("mcpStatusLastChecked", {
                timestamp: mcpStatusCheckedAtLabel,
              })}
            </p>
          </div>
        ) : null}
      </SettingsSection>

      {/* MCP Configuration Editor */}
      <SettingsSection heading={t("mcpJsonCardTitle")}>
        <div className="px-5 py-4">
          <div className="flex flex-col gap-4">
            {mcpConfig?.is_toml_config ? (
              <p className="font-workspace text-[12px] text-muted-foreground">
                {t("mcpTomlInfo")}
              </p>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="font-workspace text-[12px] text-muted-foreground">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
                  {t("mcpJsonPathLabel")}
                </span>
                <div className="mt-1">
                  <code className="font-mono text-[12px] text-foreground">
                    {configPath}
                  </code>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReload}
                  disabled={mcpLoading}
                  className="font-workspace gap-1.5 text-[12px]"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  {t("reloadButton")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSave}
                  disabled={
                    !isDirty ||
                    !!validationError ||
                    mcpLoading ||
                    saveState === "saving"
                  }
                  className="font-workspace gap-1.5 text-[12px]"
                >
                  {saveState === "saving" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  {t("saveButton")}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="font-workspace text-[11px] uppercase tracking-wide text-muted-foreground">
                {t(
                  mcpConfig?.is_toml_config
                    ? "mcpJsonLabelToml"
                    : "mcpJsonLabel",
                )}
              </Label>
              <Suspense fallback={<EditorLoadingState />}>
                <McpJsonEditor
                  value={configContent}
                  onChange={handleContentChange}
                  disabled={mcpLoading}
                  minHeight={560}
                  ariaLabel={t(
                    mcpConfig?.is_toml_config
                      ? "mcpJsonLabelToml"
                      : "mcpJsonLabel",
                  )}
                />
              </Suspense>
              {validationError ? (
                <p className="font-workspace text-[12px] text-destructive">
                  {validationError}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </SettingsSection>

      {mcpLoading ? (
        <div className="font-workspace flex items-center justify-center gap-2 p-3 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("loadingMessage")}
        </div>
      ) : null}
    </section>
  );

  const agentExecutorOptions = useMemo(() => {
    const base = availableExecutors.length
      ? availableExecutors
      : DEFAULT_MCP_EXECUTORS;
    const merged = [...base, ...DEFAULT_MCP_EXECUTORS];
    return Array.from(new Set(merged)) as BaseCodingAgent[];
  }, [availableExecutors]);
  const defaultExecutorLabel = useMemo(() => {
    if (!executorProfileId) {
      return t("agentProfileUnknown");
    }
    return t(MCP_EXECUTOR_LABEL_KEYS[executorProfileId.executor]);
  }, [executorProfileId, t]);
  const agentCliStatusByName = useMemo(
    () =>
      new Map((agentCliStatuses ?? []).map((status) => [status.name, status])),
    [agentCliStatuses],
  );

  const agentsSection = (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="font-workspace text-[20px] font-bold text-foreground">
          {t("settingsTabsAgents")}
        </h2>
        <p className="font-workspace text-[13px] text-muted-foreground mt-1">
          {t("agentsSettingsDescription")}
        </p>
      </div>

      {executorProfileError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("agentProfileLoadError")}</AlertTitle>
          <AlertDescription>{executorProfileError}</AlertDescription>
        </Alert>
      ) : null}

      {/* Default Agent Selector */}
      <SettingsSection heading={t("agentsDefaultExecutorTitle")}>
        <SettingsRow
          title={t("agentsDefaultExecutorTitle")}
          description={t("agentsDefaultExecutorDescription")}
          disabled={executorProfileLoading || profileSaving}
          control={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  disabled={executorProfileLoading || profileSaving}
                  className="font-workspace flex h-9 min-w-[180px] items-center justify-between rounded-lg border border-border/40 bg-custom-background-90 px-3 text-[13px] text-foreground transition hover:border-border/60 hover:bg-custom-background-80 focus-visible:ring-1 focus-visible:ring-primary"
                >
                  <span className="truncate">{defaultExecutorLabel}</span>
                  <ChevronDown className="h-4 w-4 text-current" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-[220px] rounded-lg border border-border/50 bg-custom-background-100 p-1"
              >
                <DropdownMenuLabel className="font-workspace px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("agentsDefaultExecutorTitle")}
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="mx-1 my-0.5 bg-border/60" />
                {agentExecutorOptions.map((option) => {
                  const isActive = executorProfileId?.executor === option;
                  return (
                    <DropdownMenuItem
                      key={option}
                      onClick={() => {
                        setUiValue("chro:selected-executor", option);
                        void handleExecutorSelect(option);
                      }}
                      className="font-workspace cursor-pointer rounded px-2 py-1.5 text-[13px] text-foreground"
                    >
                      <div className="flex w-full items-center justify-between">
                        <span>{t(MCP_EXECUTOR_LABEL_KEYS[option])}</span>
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

      <SettingsSection
        heading={t("agentsCliStatusTitle")}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void reloadAgentCliStatuses()}
            disabled={agentCliStatusesLoading}
            className="font-workspace gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            {agentCliStatusesLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" />
            )}
            {t("agentsCliStatusRefresh")}
          </Button>
        }
      >
        {agentCliStatusesError ? (
          <div className="px-5 py-4">
            <Alert
              variant="destructive"
              className="border-destructive/40 bg-destructive/10"
            >
              <AlertDescription className="text-[12px]">
                {t("agentsCliStatusLoadError")}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {agentCliStatuses === null && agentCliStatusesLoading ? (
          <div className="flex items-center gap-2 px-5 py-4 font-workspace text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("agentsCliStatusLoading")}
          </div>
        ) : null}

        {agentCliStatuses !== null
          ? AGENT_CLI_ORDER.map((executor) => {
              const status = agentCliStatusByName.get(
                AGENT_CLI_NAMES[executor],
              );
              if (!status) return null;

              return (
                <SettingsRow
                  key={executor}
                  title={t(MCP_EXECUTOR_LABEL_KEYS[executor])}
                  description={status.found ? undefined : status.install_hint}
                  control={
                    <div className="flex items-center gap-1.5 font-workspace text-[12px] tabular-nums text-muted-foreground">
                      {status.found ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5" />
                      )}
                      <span>
                        {status.version ??
                          (status.found
                            ? t("agentsCliVersionUnavailable")
                            : t("agentsCliNotFound"))}
                      </span>
                    </div>
                  }
                >
                  {status.found && (status.path || status.source) ? (
                    <div className="space-y-1 rounded-md bg-muted/20 px-3 py-2 font-workspace text-[11px] text-muted-foreground">
                      {status.path ? (
                        <p className="truncate" title={status.path}>
                          <span className="text-muted-foreground/70">
                            {t("agentsCliPathLabel")}:{" "}
                          </span>
                          <span className="text-foreground/80">
                            {status.path}
                          </span>
                        </p>
                      ) : null}
                      {status.source ? (
                        <p className="truncate" title={status.source}>
                          <span className="text-muted-foreground/70">
                            {t("agentsCliSourceLabel")}:{" "}
                          </span>
                          <span className="text-foreground/80">
                            {status.source}
                          </span>
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </SettingsRow>
              );
            })
          : null}
      </SettingsSection>

      <SettingsSection heading={t("agentsPiCredentialsTitle")}>
        <SettingsRow
          title={t("agentsPiApiKeysTitle")}
          description={t("agentsPiApiKeysDescription")}
        >
          <PiApiKeysControl t={t} />
        </SettingsRow>
      </SettingsSection>
    </section>
  );

  const editorSection = (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="font-workspace text-[20px] font-bold text-foreground">
          {t("editorSettingsTitle")}
        </h2>
        <p className="font-workspace text-[13px] text-muted-foreground mt-1">
          {t("editorSettingsDescription")}
        </p>
      </div>

      <SettingsSection>
        <SettingsRow
          title={t("editorFontSizeTitle")}
          description={t("editorFontSizeDescription")}
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
                    {editorConfig.font_size}px
                  </span>
                  <ChevronDown className="h-4 w-4 text-current" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-[120px] rounded-lg border border-border/50 bg-custom-background-100 p-1"
              >
                {[12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32].map((size) => {
                  const isActive = editorConfig.font_size === size;
                  return (
                    <DropdownMenuItem
                      key={size}
                      onClick={() =>
                        void updateEditorConfig({ font_size: size })
                      }
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
          title={t("editorLineHeightTitle")}
          description={t("editorLineHeightDescription")}
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
                    {editorConfig.line_height.toFixed(1)}
                  </span>
                  <ChevronDown className="h-4 w-4 text-current" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-[120px] rounded-lg border border-border/50 bg-custom-background-100 p-1"
              >
                {[1.0, 1.2, 1.4, 1.5, 1.6, 1.8, 2.0, 2.2, 2.5].map((lh) => {
                  const isActive =
                    editorConfig.line_height.toFixed(1) === lh.toFixed(1);
                  return (
                    <DropdownMenuItem
                      key={lh}
                      onClick={() =>
                        void updateEditorConfig({ line_height: lh })
                      }
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

  const developerSection = (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="font-workspace text-[20px] font-bold text-foreground">
          {t("settingsTabsDeveloper")}
        </h2>
        <p className="font-workspace text-[13px] text-muted-foreground mt-1">
          {t("developerTabDescription")}
        </p>
      </div>

      <SettingsSection
        heading={t("developerWorktreeTitle")}
        description={t("developerWorktreeDescription")}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadWorktreeInfo()}
            disabled={worktreeLoading}
            className="font-workspace gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            {t("reloadButton")}
          </Button>
        }
      >
        {worktreeError ? (
          <div className="px-5 py-4">
            <Alert
              variant="destructive"
              className="border-destructive/40 bg-destructive/10"
            >
              <AlertDescription>{worktreeError}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        {worktreeCleanupState === "success" && worktreeCleanupResult ? (
          <div className="px-5 py-3">
            <p className="font-workspace text-[12px] text-emerald-500">
              {t("developerWorktreeCleanupSuccess", {
                count: worktreeCleanupResult.deletedCount,
                size: formatBytes(worktreeCleanupResult.freedBytes),
              })}
            </p>
          </div>
        ) : null}

        {worktreeLoading ? (
          <div className="px-5 py-4">
            <div className="font-workspace flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("loadingMessage")}
            </div>
          </div>
        ) : worktreeInfo ? (
          <>
            {/* Summary row */}
            <div className="flex items-center justify-between px-5 py-4">
              <div className="flex flex-col gap-0.5">
                <span className="font-workspace text-[11px] uppercase tracking-wide text-muted-foreground">
                  {t("developerWorktreeBaseDir")}
                </span>
                <code className="font-workspace text-[12px] text-foreground break-all">
                  {worktreeInfo.base_dir}
                </code>
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <span className="font-workspace text-[11px] uppercase tracking-wide text-muted-foreground">
                  {t("developerWorktreeTotalSize")}
                </span>
                <span className="font-workspace text-[13px] font-semibold text-foreground">
                  {worktreeTotalSize != null
                    ? formatBytes(worktreeTotalSize)
                    : worktreeSizesLoading
                      ? t("developerWorktreeCalculatingSize")
                      : "—"}
                </span>
              </div>
            </div>

            {/* Worktree entries */}
            {worktreeInfo.entries.length === 0 ? (
              <div className="px-5 py-4">
                <p className="font-workspace text-[12px] text-muted-foreground">
                  {t("developerWorktreeEmpty")}
                </p>
              </div>
            ) : (
              <>
                {/* Select all header */}
                <div className="flex items-center gap-3 px-5 py-2 border-b border-border/50">
                  <input
                    type="checkbox"
                    checked={selectedPaths.size === worktreeInfo.entries.length}
                    ref={(el) => {
                      if (el) {
                        el.indeterminate =
                          selectedPaths.size > 0 &&
                          selectedPaths.size < worktreeInfo.entries.length;
                      }
                    }}
                    onChange={toggleSelectAll}
                    disabled={worktreeCleanupState === "cleaning"}
                    className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
                  />
                  <span className="font-workspace text-[11px] text-muted-foreground">
                    {selectedPaths.size > 0
                      ? t("developerWorktreeSelectedCount", {
                          count: selectedPaths.size,
                        })
                      : t("developerWorktreeSelectAll")}
                  </span>
                </div>

                {worktreeInfo.entries.map((entry) => (
                  <div
                    key={entry.path}
                    role="button"
                    tabIndex={0}
                    className={cn(
                      "flex items-center gap-3 px-5 py-4 cursor-pointer transition-colors",
                      selectedPaths.has(entry.path) && "bg-accent/50",
                    )}
                    onClick={() => toggleSelection(entry.path)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleSelection(entry.path);
                      }
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedPaths.has(entry.path)}
                      onChange={() => toggleSelection(entry.path)}
                      onClick={(e) => e.stopPropagation()}
                      disabled={worktreeCleanupState === "cleaning"}
                      className="h-3.5 w-3.5 shrink-0 rounded border-border accent-primary cursor-pointer"
                    />
                    <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span className="font-workspace text-[13px] font-medium text-foreground truncate">
                        {entry.name}
                      </span>
                      <div className="flex items-center gap-3">
                        <span className="font-workspace text-[11px] text-muted-foreground">
                          {worktreeSizes && worktreeSizes[entry.path] != null
                            ? formatBytes(worktreeSizes[entry.path])
                            : worktreeSizesLoading
                              ? t("developerWorktreeCalculatingSize")
                              : "—"}
                        </span>
                        {entry.modified_at ? (
                          <span className="font-workspace text-[11px] text-muted-foreground">
                            {new Date(entry.modified_at).toLocaleString()}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleCleanupSingleWorktree(entry.path);
                      }}
                      disabled={worktreeCleanupState === "cleaning"}
                      className="font-workspace gap-1 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                      {t("deleteButton")}
                    </Button>
                  </div>
                ))}
              </>
            )}

            {/* Cleanup actions */}
            {worktreeInfo.entries.length > 0 ? (
              <div className="flex items-center gap-2 px-5 py-4 border-t border-border/50">
                {selectedPaths.size > 0 ? (
                  <Button
                    variant="destructive"
                    onClick={() => void handleCleanupSelectedWorktrees()}
                    disabled={worktreeCleanupState === "cleaning"}
                    className="font-workspace gap-1.5 text-[12px]"
                  >
                    {worktreeCleanupState === "cleaning" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    {t("developerWorktreeCleanupSelected", {
                      count: selectedPaths.size,
                    })}
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    onClick={() => void handleCleanupAllWorktrees()}
                    disabled={worktreeCleanupState === "cleaning"}
                    className="font-workspace gap-1.5 text-[12px]"
                  >
                    {worktreeCleanupState === "cleaning" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    {t("developerWorktreeCleanupAll")}
                  </Button>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </SettingsSection>
    </section>
  );

  return (
    <div
      className={cn(
        "flex h-full w-full overflow-hidden text-foreground",
        isModal ? "bg-transparent" : "bg-custom-background-100",
        className,
      )}
    >
      <div className="flex h-full w-full overflow-hidden bg-custom-background-100">
        <aside className="hidden h-full w-[220px] flex-col border-r border-border/60 bg-custom-sidebar-background-100 p-3 text-sm md:flex">
          <div className="flex flex-1 flex-col gap-1 overflow-y-auto pr-1">
            {navItems.map((item) => {
              const isActive = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                  className={cn(
                    "font-workspace text-[13px] leading-[1.35] flex w-full flex-col items-start gap-0.5 rounded-sm px-2.5 py-1.5 text-left outline-none",
                    isActive
                      ? "bg-custom-sidebar-background-80 text-foreground"
                      : "text-custom-sidebar-text-200 hover:bg-custom-sidebar-background-80",
                  )}
                  aria-pressed={isActive}
                >
                  <span className="font-workspace text-[13px]">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>
        <div className="flex flex-1 flex-col">
          {/* Mobile tab navigation */}
          <div className="flex gap-1.5 border-b border-border/60 bg-custom-background-90 px-3 py-2 md:hidden">
            {navItems.map((item) => {
              const isActive = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                  className={cn(
                    "font-workspace flex-1 rounded px-3 py-1.5 text-[11px] font-medium transition",
                    isActive
                      ? "bg-custom-background-80/75 text-custom-text-200"
                      : "bg-custom-background-90 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
            {activeTab === "general" ? generalSection : null}
            {activeTab === "appearance" ? <AppearancePane /> : null}
            {activeTab === "workspace" ? workspaceSection : null}
            {activeTab === "editor" ? editorSection : null}
            {activeTab === "notifications" ? <NotificationsPane /> : null}
            {activeTab === "mcp" ? mcpSection : null}
            {activeTab === "agents" ? agentsSection : null}
            {activeTab === "developer" ? developerSection : null}
          </main>
        </div>
      </div>
    </div>
  );
}

function EditorLoadingState() {
  return (
    <div className="flex h-[320px] w-full items-center justify-center rounded border border-border/60 bg-custom-background-90 text-[11px] text-muted-foreground">
      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
      Loading editor...
    </div>
  );
}
