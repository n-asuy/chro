import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { McpConfigStrategyGeneral, type McpConfig } from "../mcp-strategy";
import { fetchMcpConfig, saveMcpConfigRequest } from "@/lib/mcp-config-client";
import {
  checkMcpStatus,
  type BaseCodingAgent,
  type ExecutorProfileId,
  type McpStatusResult,
} from "@/lib/executor-client";
import type { TranslationFunction } from "@/i18n";

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toJsonRecord(value: unknown): Record<string, unknown> {
  return isJsonRecord(value) ? (value as Record<string, unknown>) : {};
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeMcpConfig(value: Record<string, unknown>): McpConfig {
  const {
    servers,
    servers_path: serversPath,
    template,
    is_toml_config: isTomlConfig,
  } = value;

  return {
    servers: toJsonRecord(servers),
    servers_path: toStringArray(serversPath),
    template: toJsonRecord(template),
    is_toml_config: typeof isTomlConfig === "boolean" ? isTomlConfig : false,
  };
}

type McpSettingsArgs = {
  defaultExecutor: BaseCodingAgent;
  executorProfileId: ExecutorProfileId | null;
  supportedExecutors: BaseCodingAgent[];
  t: TranslationFunction;
};

type McpSettingsState = {
  configPath: string;
  configContent: string;
  isDirty: boolean;
  mcpTargetExecutor: BaseCodingAgent;
  mcpConfig: McpConfig | null;
  mcpLoading: boolean;
  loadError: string | null;
  validationError: string | null;
  parseWarning: string | null;
  saveState: "idle" | "saving" | "success" | "error";
  saveError: string | null;
  mcpStatusResult: McpStatusResult | null;
  mcpStatusLoading: boolean;
  mcpStatusError: string | null;
  mcpStatusCheckedAtLabel: string | null;
  mcpStatusSupported: boolean;
  handleMcpTargetSelect: (executor: BaseCodingAgent) => void;
  handleContentChange: (value: string) => void;
  handleSave: () => Promise<void>;
  handleReload: () => void;
  loadMcpStatus: () => Promise<void>;
};

export function useMcpSettings({
  defaultExecutor,
  executorProfileId,
  supportedExecutors,
  t,
}: McpSettingsArgs): McpSettingsState {
  const [configPath, setConfigPath] = useState("~/.claude.json");
  const [configContent, setConfigContent] = useState("{}");
  const [initialContent, setInitialContent] = useState("{}");
  const [mcpTargetExecutor, setMcpTargetExecutor] =
    useState<BaseCodingAgent>(defaultExecutor);
  const mcpExecutorSelectionRef = useRef(false);
  const [mcpConfig, setMcpConfig] = useState<McpConfig | null>(null);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [parseWarning, setParseWarning] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "success" | "error"
  >("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const validationTimeoutRef = useRef<number | null>(null);

  // MCP status check state
  const [mcpStatusResult, setMcpStatusResult] =
    useState<McpStatusResult | null>(null);
  const [mcpStatusLoading, setMcpStatusLoading] = useState(false);
  const [mcpStatusError, setMcpStatusError] = useState<string | null>(null);
  const [mcpStatusCheckedAt, setMcpStatusCheckedAt] = useState<string | null>(
    null,
  );

  const isDirty = configContent !== initialContent;

  const handleMcpTargetSelect = useCallback(
    (executor: BaseCodingAgent) => {
      if (executor === mcpTargetExecutor) return;
      mcpExecutorSelectionRef.current = true;
      setMcpTargetExecutor(executor);
    },
    [mcpTargetExecutor],
  );

  const mcpStatusSupported = supportedExecutors.includes(mcpTargetExecutor);

  const loadMcpStatus = useCallback(async () => {
    if (!mcpStatusSupported) {
      setMcpStatusResult(null);
      setMcpStatusCheckedAt(null);
      setMcpStatusError(null);
      return;
    }

    setMcpStatusLoading(true);
    setMcpStatusError(null);

    try {
      const result = await checkMcpStatus(mcpTargetExecutor);
      const timestamp = new Date().toISOString();
      if (result.ok) {
        setMcpStatusResult(result);
        setMcpStatusCheckedAt(timestamp);
      } else {
        setMcpStatusResult({ ok: false, servers: [] });
        setMcpStatusError(result.message ?? t("mcpStatusError"));
        setMcpStatusCheckedAt(timestamp);
      }
    } catch (error) {
      setMcpStatusResult(null);
      setMcpStatusError(
        error instanceof Error ? error.message : t("mcpStatusError"),
      );
      setMcpStatusCheckedAt(new Date().toISOString());
    } finally {
      setMcpStatusLoading(false);
    }
  }, [mcpStatusSupported, mcpTargetExecutor, t]);

  const mcpStatusCheckedAtLabel = useMemo(() => {
    if (!mcpStatusCheckedAt) return null;
    try {
      return new Date(mcpStatusCheckedAt).toLocaleString();
    } catch {
      return mcpStatusCheckedAt;
    }
  }, [mcpStatusCheckedAt]);

  const cancelPendingValidation = useCallback(() => {
    if (validationTimeoutRef.current !== null) {
      window.clearTimeout(validationTimeoutRef.current);
      validationTimeoutRef.current = null;
    }
  }, []);

  const scheduleValidation = useCallback(
    (value: string) => {
      cancelPendingValidation();
      validationTimeoutRef.current = window.setTimeout(() => {
        if (!mcpConfig) return;
        try {
          const parsed = JSON.parse(value) as Record<string, unknown>;
          McpConfigStrategyGeneral.validateFullConfig(mcpConfig, parsed);
          McpConfigStrategyGeneral.extractServersForApi(mcpConfig, parsed);
          setValidationError(null);
        } catch (error) {
          if (error instanceof SyntaxError) {
            setValidationError(t("mcpJsonSyntaxError"));
          } else {
            setValidationError(
              error instanceof Error ? error.message : t("mcpJsonParseFailure"),
            );
          }
        }
      }, 150);
    },
    [cancelPendingValidation, mcpConfig, t],
  );

  const loadConfig = useCallback(async () => {
    setMcpLoading(true);
    setLoadError(null);
    setSaveState("idle");
    setSaveError(null);

    try {
      const response = await fetchMcpConfig(mcpTargetExecutor);
      const normalizedConfig = normalizeMcpConfig(response.mcpConfig);

      cancelPendingValidation();
      setConfigPath(response.configPath);
      setMcpConfig(normalizedConfig);
      setParseWarning(response.parseError ?? null);
      setValidationError(response.parseError ?? null);

      const shouldUseRawContent = Boolean(
        response.parseError &&
          response.rawContent &&
          !normalizedConfig.is_toml_config,
      );

      const content = shouldUseRawContent
        ? response.rawContent!
        : JSON.stringify(
            McpConfigStrategyGeneral.createFullConfig(normalizedConfig),
            null,
            2,
          );

      setConfigContent(content);
      setInitialContent(content);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : t("mcpLoadFailure"),
      );
    } finally {
      setMcpLoading(false);
    }
  }, [cancelPendingValidation, mcpTargetExecutor, t]);

  const handleContentChange = useCallback(
    (value: string) => {
      setParseWarning(null);
      setConfigContent(value);
      scheduleValidation(value);
    },
    [scheduleValidation],
  );

  const handleSave = useCallback(async () => {
    if (!mcpConfig) return;
    try {
      const parsed = JSON.parse(configContent) as Record<string, unknown>;
      McpConfigStrategyGeneral.validateFullConfig(mcpConfig, parsed);
      const servers = McpConfigStrategyGeneral.extractServersForApi(
        mcpConfig,
        parsed,
      );

      setSaveState("saving");
      setSaveError(null);

      const response = await saveMcpConfigRequest(servers, mcpTargetExecutor);
      const normalizedConfig = normalizeMcpConfig(response.mcpConfig);
      cancelPendingValidation();
      const nextConfig =
        McpConfigStrategyGeneral.createFullConfig(normalizedConfig);
      const nextContent = JSON.stringify(nextConfig, null, 2);

      setMcpConfig(normalizedConfig);
      setConfigContent(nextContent);
      setInitialContent(nextContent);
      setValidationError(null);
      setParseWarning(null);
      setSaveState("success");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch (error) {
      setSaveState("error");
      setSaveError(
        error instanceof Error ? error.message : t("mcpSaveFailure"),
      );
    }
  }, [cancelPendingValidation, configContent, mcpConfig, mcpTargetExecutor, t]);

  const handleReload = useCallback(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    return () => {
      cancelPendingValidation();
    };
  }, [cancelPendingValidation]);

  useEffect(() => {
    if (executorProfileId && !mcpExecutorSelectionRef.current) {
      setMcpTargetExecutor(executorProfileId.executor);
    }
  }, [executorProfileId]);

  useEffect(() => {
    if (!mcpStatusSupported) {
      setMcpStatusResult(null);
      setMcpStatusCheckedAt(null);
      setMcpStatusError(null);
    }
  }, [mcpStatusSupported]);

  useEffect(() => {
    setMcpStatusResult(null);
    setMcpStatusCheckedAt(null);
    setMcpStatusError(null);
  }, [mcpTargetExecutor]);

  return {
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
  };
}
