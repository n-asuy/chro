import type { TranslationFunction } from "@/i18n";
import en from "@/i18n/locales/en";
import ja from "@/i18n/locales/ja";
import { describe, expect, it } from "vitest";
import { localizeCloudMessage } from "./cloud-messages";

describe.each([
  ["en", en],
  ["ja", ja],
] as const)("cloud messages (%s)", (_language, locale) => {
  const t: TranslationFunction = (key) => locale[key];
  it("localizes replayed cloud statuses and session errors", () => {
    for (const [raw, expected] of [
      ["Preparing cloud environment…", locale.cloudPreparing],
      ["Agent is running in Cloud.", locale.cloudAgentRunning],
      [
        "Cloud result imported into this session’s branch.",
        locale.cloudResultImported,
      ],
      ["Cloud sign-in expired. Sign in again.", locale.cloudErrorExpired],
      [
        "Cloud instance limit reached. Stop another cloud session and try again.",
        locale.cloudErrorLimit,
      ],
      [
        "Cloud requires a Git repository; image attachments are not supported yet",
        locale.cloudErrorRepository,
      ],
      [
        "Cloud image attachments are not supported yet",
        locale.cloudErrorImages,
      ],
      [
        "execution location cannot change after a session starts",
        locale.cloudErrorLocationLocked,
      ],
      [
        "Cloud is not configured. Set CHRO_CLOUD_CONTROL_PLANE_URL and CHRO_CLOUD_ACCESS_AUDIENCE.",
        locale.cloudErrorConfiguration,
      ],
    ])
      expect(localizeCloudMessage(raw, t)).toBe(expected);
  });
  it("keeps unrelated agent diagnostics and localizes unknown sign-in failures", () => {
    expect(localizeCloudMessage("Agent executable missing", t)).toBe(
      "Agent executable missing",
    );
    expect(
      localizeCloudMessage("keychain unavailable", t, "cloudSignInFailed"),
    ).toBe(locale.cloudSignInFailed);
  });
});
