import { type TranslationKey, useLanguage } from "@/i18n";
import { desktopFetch } from "@/lib/backend-client";
import { localizeCloudMessage } from "@/lib/cloud-messages";
import { useFeatureFlagStore, useFlag } from "@/lib/feature-flags-store";
import type { FlagKey } from "@/lib/flags.generated";
import { Switch } from "@chro/ui/switch";
import { useState } from "react";
import { SettingsRow } from "./settings-row";
import { SettingsSection } from "./settings-section";

interface BetaFeature {
  key: FlagKey;
  title: TranslationKey;
  description: TranslationKey;
}

/**
 * The beta features a user can be offered, in display order.
 *
 * This list, not the flag registry, decides what appears in settings: a flag
 * shows up here only once someone has written user-facing copy for it. Flags
 * guarding half-built work therefore stay invisible by construction, instead
 * of leaking into the UI the moment they are registered.
 */
const BETA_FEATURES: BetaFeature[] = [
  {
    key: "session_references_popover",
    title: "betaTaskReferencesTitle",
    description: "betaTaskReferencesDescription",
  },
  {
    key: "edge_toolbar",
    title: "betaEdgeToolbarTitle",
    description: "betaEdgeToolbarDescription",
  },
];

/**
 * Beta features this installation has been offered.
 *
 * Being offered one is resolved by the backend; the switch here turns an
 * offered feature off (opt-out features) or on (opt-in features, off until
 * the user chooses them). The section disappears entirely when nothing is on
 * offer.
 */
export function BetaFeaturesSection() {
  const { t } = useLanguage();
  const resolved = useFeatureFlagStore((store) => store.resolved);

  const cloudEnabled = useFlag("cloud_sessions");
  const offered = BETA_FEATURES.filter((feature) => resolved[feature.key]);
  if (offered.length === 0 && !cloudEnabled) return null;

  return (
    <SettingsSection
      heading={t("betaFeaturesTitle")}
      description={t("betaFeaturesDescription")}
    >
      {cloudEnabled && <CloudSignInRow />}
      {offered.map((feature) => (
        <BetaFeatureRow key={feature.key} feature={feature} />
      ))}
    </SettingsSection>
  );
}

function BetaFeatureRow({ feature }: { feature: BetaFeature }) {
  const { t } = useLanguage();
  const enabled = useFlag(feature.key);
  const setBetaEnabled = useFeatureFlagStore((store) => store.setBetaEnabled);

  return (
    <SettingsRow
      title={t(feature.title)}
      description={t(feature.description)}
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => setBetaEnabled(feature.key, checked)}
          aria-label={t(feature.title)}
        />
      }
    />
  );
}

function CloudSignInRow() {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsRow
      title={t("cloudSignInTitle")}
      description={
        error !== null
          ? localizeCloudMessage(error, t, "cloudSignInFailed")
          : t(signedIn ? "cloudSignedIn" : "cloudSignInDescription")
      }
      control={
        <button
          type="button"
          disabled={busy}
          className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await desktopFetch("/rpc/cloud/login", { method: "POST" });
              setSignedIn(true);
            } catch (error) {
              setError(error instanceof Error ? error.message : "");
            } finally {
              setBusy(false);
            }
          }}
        >
          {t(busy ? "cloudSigningIn" : "cloudSignIn")}
        </button>
      }
    />
  );
}
