import { type TranslationKey, useLanguage } from "@/i18n";
import { useCloudAccessStore } from "@/lib/cloud-access-store";
import { useFeatureFlagStore, useFlag } from "@/lib/feature-flags-store";
import type { FlagKey } from "@/lib/flags.generated";
import { Button } from "@chro/ui/button";
import { Switch } from "@chro/ui/switch";
import { Loader2 } from "lucide-react";
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

  const offered = BETA_FEATURES.filter((feature) => resolved[feature.key]);

  return (
    <SettingsSection
      heading={t("betaFeaturesTitle")}
      description={t("betaFeaturesDescription")}
    >
      <CloudSignInRow />
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
  const {
    configured,
    signedIn,
    busy,
    signingOut,
    email,
    signInUrl,
    error,
    signIn,
    signOut,
    cancel,
  } = useCloudAccessStore();
  const [copied, setCopied] = useState(false);
  return (
    <SettingsRow
      title={t("cloudSignInTitle")}
      description={t(
        configured === false
          ? "cloudUnavailable"
          : busy
            ? "cloudContinueInBrowser"
            : "cloudSignInDescription",
      )}
      control={
        configured && (
          <Switch
            checked={signedIn}
            disabled={busy || signingOut}
            onCheckedChange={(checked) => {
              if (checked) void signIn();
              else void signOut();
            }}
            aria-label={t("cloudSignInTitle")}
          />
        )
      }
    >
      {configured !== false && error && (
        <p role="alert" className="text-[12px] text-destructive">
          {t(error)}
        </p>
      )}
      {configured === null && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => void useCloudAccessStore.getState().refresh()}
        >
          {t("cloudRetryConnection")}
        </Button>
      )}
      {configured && (
        <div className="flex items-center gap-3">
          {busy ? (
            <>
              <Loader2
                className="size-4 animate-spin text-muted-foreground"
                aria-label={t("cloudSigningIn")}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!signInUrl}
                onClick={() => {
                  if (signInUrl)
                    void navigator.clipboard
                      .writeText(signInUrl)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false));
                }}
              >
                {t(copied ? "cloudLinkCopied" : "cloudCopySignInLink")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCopied(false);
                  void cancel();
                }}
              >
                {t("cancelButtonLabel")}
              </Button>
            </>
          ) : signedIn ? (
            <>
              <span className="text-[13px] text-foreground">
                {email || t("cloudSignedIn")}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={signingOut}
                onClick={() => void signOut()}
              >
                {t("cloudSignOut")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                setCopied(false);
                void signIn();
              }}
            >
              {t("cloudSignIn")}
            </Button>
          )}
        </div>
      )}
    </SettingsRow>
  );
}
