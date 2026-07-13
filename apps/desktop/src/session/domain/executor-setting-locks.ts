export type ExecutorSettingLockState = {
  hasTaskRun: boolean;
  isSending: boolean;
};

/**
 * The runtime is tied to the executor-specific resume session once a run
 * exists. Models are turn-level overrides, so they stay editable between
 * turns and are locked only while a turn is being submitted or executed.
 */
export const resolveExecutorSettingLocks = ({
  hasTaskRun,
  isSending,
}: ExecutorSettingLockState) => ({
  runtimeLocked: hasTaskRun || isSending,
  modelLocked: isSending,
});
