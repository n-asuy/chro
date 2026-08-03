import type { TranslationFunction, TranslationKey } from "@/i18n";

const PUSH_REJECT_HINTS = [
  "fetch first",
  "non-fast-forward",
  "remote contains work",
  "failed to push some refs",
  "rejected",
];

const isPushRejected = (message: string): boolean =>
  message.includes("git push") &&
  PUSH_REJECT_HINTS.some((hint) => message.includes(hint));

const GIT_ERROR_MATCHERS: Array<{
  match: (message: string) => boolean;
  key: TranslationKey;
}> = [
  {
    match: (message) =>
      message.includes("authentication failed") ||
      message.includes("could not read username"),
    key: "gitAuthFailed",
  },
  {
    match: (message) =>
      message.includes("permission denied") || message.includes("publickey"),
    key: "gitPermissionDenied",
  },
  {
    match: (message) => message.includes("repository not found"),
    key: "gitRepositoryNotFound",
  },
  {
    match: (message) =>
      message.includes("could not read from remote repository") ||
      message.includes("no such remote"),
    key: "gitRemoteAccessFailed",
  },
  {
    match: (message) =>
      message.includes("no upstream") ||
      message.includes("set upstream") ||
      message.includes("@{u}"),
    key: "gitNoUpstream",
  },
  // Ahead in commits but identical in content: the work already reached the
  // base. Must be read before the conflict matcher, whose broad "conflict"
  // check would otherwise claim any message mentioning one.
  {
    match: (message) => message.includes("nothing to merge"),
    key: "gitNothingToMerge",
  },
  {
    match: (message) =>
      message.includes("merge conflict") ||
      message.includes("rebase conflict") ||
      message.includes("conflict"),
    key: "gitMergeConflict",
  },
  {
    match: (message) => message.includes("rebase in progress"),
    key: "gitRebaseInProgress",
  },
  {
    match: (message) => message.includes("not a git repository"),
    key: "gitNotRepository",
  },
  {
    match: (message) =>
      message.includes("could not resolve host") ||
      message.includes("failed to connect") ||
      message.includes("connection timed out") ||
      message.includes("unable to access"),
    key: "gitNetworkError",
  },
  {
    match: (message) => message.includes("local changes would be overwritten"),
    key: "gitLocalChanges",
  },
];

const normalizeGitErrorMessage = (message: string): string =>
  message.replace(/^bad request:\s*/i, "").trim();

/**
 * Turn a failed git operation into a sentence the user can act on.
 *
 * Shared by every git verb in the UI (status/stage/commit/push/pull as well as
 * the integration verbs merge and rebase) so the same underlying failure reads
 * the same way wherever it surfaces. `fallbackKey` names the verb that failed
 * and is only used when the error carries nothing quotable.
 */
export const resolveGitError = (
  err: unknown,
  t: TranslationFunction,
  fallbackKey: TranslationKey,
): string => {
  const normalizedMessage = normalizeGitErrorMessage(
    err instanceof Error ? err.message : "",
  );
  const lower = normalizedMessage.toLowerCase();

  if (isPushRejected(lower)) {
    return t("gitPushRejectedDescription");
  }

  const matched = GIT_ERROR_MATCHERS.find((matcher) => matcher.match(lower));
  if (matched) {
    return t(matched.key);
  }

  if (normalizedMessage) {
    return t("gitErrorWithDetails", { message: normalizedMessage });
  }

  return t(fallbackKey);
};
