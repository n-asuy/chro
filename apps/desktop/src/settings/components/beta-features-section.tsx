import { type TranslationKey, useLanguage } from "@/i18n";
import { useFeatureFlagStore, useFlag } from "@/lib/feature-flags-store";
import type { FlagKey } from "@/lib/flags.generated";
import { Switch } from "@chro/ui/switch";
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
];

/**
 * Beta features this installation has been offered.
 *
 * Being offered one is resolved by the backend; the switch here only lets the
 * user turn an offered feature off. The section disappears entirely when
 * nothing is on offer, so most users never see it.
 */
export function BetaFeaturesSection() {
  const { t } = useLanguage();
  const resolved = useFeatureFlagStore((store) => store.resolved);

  const offered = BETA_FEATURES.filter((feature) => resolved[feature.key]);
  if (offered.length === 0) return null;

  return (
    <SettingsSection
      heading={t("betaFeaturesTitle")}
      description={t("betaFeaturesDescription")}
    >
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
