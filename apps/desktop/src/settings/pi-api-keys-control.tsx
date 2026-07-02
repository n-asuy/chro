import type { TranslationFunction } from "@/i18n";
import {
  type PiCredentialInfo,
  deletePiCredential,
  fetchPiCredentials,
  setPiApiKey,
} from "@/lib/executor-client";
import { cn } from "@/lib/cn";
import { Button } from "@chro/ui/button";
import { Input } from "@chro/ui/input";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

/** Sentinel select value for the free-form custom-provider id input. */
const CUSTOM_PROVIDER = "__custom__";

/**
 * Curated pi provider ids (the `auth.json` keys). Listing them as a dropdown
 * means users pick a known provider instead of guessing its exact id string.
 * Providers whose models surface in pi's catalog today are listed first; every
 * other auth-capable provider follows, and "Custom" covers anything else (e.g.
 * a self-hosted / models.json provider like `sakana`).
 */
const PROVIDERS_WITH_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter" },
];

const OTHER_PROVIDERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "anthropic", label: "Anthropic" },
  { id: "xai", label: "xAI (Grok)" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "groq", label: "Groq" },
  { id: "cerebras", label: "Cerebras" },
  { id: "mistral", label: "Mistral" },
  { id: "together", label: "Together AI" },
  { id: "fireworks", label: "Fireworks" },
  { id: "moonshotai", label: "Moonshot (Kimi)" },
  { id: "minimax", label: "MiniMax" },
  { id: "huggingface", label: "Hugging Face" },
  { id: "nvidia", label: "NVIDIA NIM" },
  { id: "amazon-bedrock", label: "Amazon Bedrock" },
];

const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  [...PROVIDERS_WITH_MODELS, ...OTHER_PROVIDERS].map((p) => [p.id, p.label]),
);

/**
 * Manage pi provider API keys in-app. Keys are written to pi's own
 * `~/.pi/agent/auth.json` (the same place `/login` and the CLI use), so a
 * GUI-launched chro works without shell environment setup. Secret values are
 * write-only — the control only ever shows which providers are configured.
 */
export function PiApiKeysControl({ t }: { t: TranslationFunction }) {
  const [credentials, setCredentials] = useState<PiCredentialInfo[] | null>(
    null,
  );
  const [selection, setSelection] = useState("");
  const [customProvider, setCustomProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provider = (
    selection === CUSTOM_PROVIDER ? customProvider : selection
  ).trim();

  const reload = useCallback(async () => {
    try {
      setCredentials(await fetchPiCredentials());
    } catch {
      setCredentials([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleAdd = useCallback(async () => {
    const trimmedKey = apiKey.trim();
    if (!provider || !trimmedKey || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await setPiApiKey(provider, trimmedKey);
      if (result.ok) {
        setSelection("");
        setCustomProvider("");
        setApiKey("");
        await reload();
      } else {
        setError(result.message ?? t("piApiKeySaveError"));
      }
    } catch {
      setError(t("piApiKeySaveError"));
    } finally {
      setBusy(false);
    }
  }, [apiKey, busy, provider, reload, t]);

  const handleRemove = useCallback(
    async (target: string) => {
      setBusy(true);
      setError(null);
      try {
        await deletePiCredential(target);
        await reload();
      } catch {
        setError(t("piApiKeySaveError"));
      } finally {
        setBusy(false);
      }
    },
    [reload, t],
  );

  const selectClassName = useMemo(
    () =>
      cn(
        "h-8 w-44 rounded-md border border-custom-border-200 bg-custom-background-100",
        "px-2 text-[13px] text-foreground outline-none",
        "focus:border-custom-primary-100",
      ),
    [],
  );

  return (
    <div className="flex flex-col gap-3 font-workspace">
      {credentials === null ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("loadingMessage")}
        </div>
      ) : credentials.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          {t("piApiKeyNone")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {credentials.map((credential) => (
            <li
              key={credential.provider}
              className="flex items-center justify-between gap-2 rounded-md border border-custom-border-200 px-3 py-1.5"
            >
              <span className="flex items-center gap-2 text-[13px]">
                <span className="text-foreground">
                  {PROVIDER_LABELS[credential.provider] ?? credential.provider}
                </span>
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {credential.kind === "oauth"
                    ? t("piApiKeyKindOauth")
                    : t("piApiKeyKindApiKey")}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={busy}
                aria-label={t("piApiKeyRemove")}
                onClick={() => void handleRemove(credential.provider)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <select
          value={selection}
          onChange={(event) => setSelection(event.target.value)}
          className={selectClassName}
          aria-label={t("piApiKeyProviderSelect")}
        >
          <option value="" disabled>
            {t("piApiKeyProviderSelect")}
          </option>
          <optgroup label={t("piApiKeyProviderGroupModels")}>
            {PROVIDERS_WITH_MODELS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </optgroup>
          <optgroup label={t("piApiKeyProviderGroupOther")}>
            {OTHER_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </optgroup>
          <option value={CUSTOM_PROVIDER}>
            {t("piApiKeyProviderCustom")}
          </option>
        </select>

        {selection === CUSTOM_PROVIDER ? (
          <Input
            value={customProvider}
            onChange={(event) => setCustomProvider(event.target.value)}
            placeholder={t("piApiKeyProviderPlaceholder")}
            className="h-8 w-32 text-[13px]"
            spellCheck={false}
            autoCapitalize="none"
          />
        ) : null}

        <Input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleAdd();
          }}
          placeholder={t("piApiKeyValuePlaceholder")}
          className="h-8 flex-1 text-[13px]"
          spellCheck={false}
          autoCapitalize="none"
        />
        <Button
          size="sm"
          className="h-8"
          disabled={busy || !provider || !apiKey.trim()}
          onClick={() => void handleAdd()}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {t("piApiKeyAdd")}
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {t("piApiKeyProviderHint")}
      </p>

      {error ? (
        <p className="text-[12px] text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
