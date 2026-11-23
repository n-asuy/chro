import type { TranslationFunction, TranslationKey } from "@/i18n";

// The server/CLI keeps diagnostic messages in English. Translate cloud-owned
// status and failure messages at presentation time, including replayed run logs.
const CLOUD_MESSAGES: [RegExp, TranslationKey][] = [
  [/Preparing cloud environment/, "cloudPreparing"],
  [/Agent is running in Cloud/, "cloudAgentRunning"],
  [/Cloud result imported/, "cloudResultImported"],
  [/Could not deliver cloud approval/, "cloudErrorApproval"],
  [/This account cannot use cloud sessions/, "cloudAccountRefused"],
  [/Cloud sign-in expired/, "cloudErrorExpired"],
  [/Sign in to Cloud first/, "cloudErrorSignInFirst"],
  [/Cloud instance limit/, "cloudErrorLimit"],
  [/Cannot reach cloud service/, "cloudErrorConnection"],
  [/Cloud requires a Git repository/, "cloudErrorRepository"],
  [/Cloud image attachments/, "cloudErrorImages"],
  [/execution location cannot change/, "cloudErrorLocationLocked"],
  [/Cloud repository upload failed/, "cloudErrorUpload"],
  [
    /Cloud.*(?:not configured|audience is missing)|Configure CHRO_CLOUD_ACCESS_AUDIENCE|Cannot locate cloud configuration/,
    "cloudErrorConfiguration",
  ],
  [/Cloud.*(?:timed out|took too long)/, "cloudErrorTimeout"],
  [/^Cloud\b|^Unknown cloud\b/, "cloudErrorFailed"],
];

export function localizeCloudMessage(
  message: string,
  t: TranslationFunction,
  fallback?: TranslationKey,
): string {
  const key = CLOUD_MESSAGES.find(([pattern]) => pattern.test(message))?.[1];
  return key ? t(key) : fallback ? t(fallback) : message;
}
