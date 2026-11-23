import { useLanguage } from "@/i18n";
import { ImageUploadPreviewList } from "@/session/components/image-upload-preview-list";
import { PromptEditor } from "@/session/components/prompt-editor/prompt-editor";
import { SendButtonWithState } from "@/session/components/session-input-controls";
import { useImageUploads } from "@/session/hooks/use-image-uploads";
import { usePromptEditorHandle } from "@/session/hooks/use-prompt-editor";
import { useSessionQueueStream } from "@/session/hooks/use-session-queue-stream";
import { parseExecutorProfileId } from "@/session/lib/executor-profile";
import { preparePromptPayload } from "@/session/lib/prompt-payload";
import { composerSubmitIntent } from "@/session/lib/session-queue";
import type { StoredTask, TaskRunRecord } from "@/session/types";
import {
  queueTaskMessage,
  sendTaskMessage,
} from "@/session/utils/task-message-api";
import { Plus } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";

interface EdgeComposerProps {
  task: StoredTask;
  /** The run a follow-up continues: its runtime and model are kept. */
  run: TaskRunRecord | null;
  isSending: boolean;
  isStopping: boolean;
  onCancel: () => void;
  /** A control placed before the send button. */
  accessory?: ReactNode;
}

/**
 * A compact composer: attach images (+), the session's prompt editor, and
 * send/stop. It sends a follow-up the way the session window does: straight
 * into the session when it is idle, into its queue while a turn runs.
 */
export function EdgeComposer({
  task,
  run,
  isSending,
  isStopping,
  onCancel,
  accessory,
}: EdgeComposerProps) {
  const { t } = useLanguage();
  // Its own editor scope, so a draft here never mixes with the session
  // window's composer for the same session.
  const editor = usePromptEditorHandle(`edge:${task.id}`);
  const queued = useSessionQueueStream({ taskId: task.id });
  // Shown inline: the edge window is only as large as its content, so a
  // toast in a screen corner would never be seen.
  const [error, setError] = useState<string | null>(null);

  const formatUploadError = useCallback(
    (file: File, cause: unknown) =>
      t("imageUploadFailed", {
        name: file.name,
        error: cause instanceof Error ? cause.message : t("internalError"),
      }),
    [t],
  );
  const runId = run?.id ?? null;
  const getUploadTarget = useCallback(
    () =>
      runId
        ? { type: "taskRun" as const, taskRunId: runId }
        : { type: "global" as const },
    [runId],
  );
  const {
    uploadItems,
    fileInputRef,
    handleFiles,
    handleSelectFiles,
    handleRetryUpload,
    handleRemoveUpload,
    clearUploadItems,
    getImageIds,
    getImagesMarkdown,
  } = useImageUploads({
    getUploadTarget,
    addErrorMessage: setError,
    formatUploadError,
  });
  const isUploading = uploadItems.some((item) => item.status === "uploading");

  const handleSend = useCallback(async () => {
    if (editor.isEmpty() || isUploading) return;
    const payload = preparePromptPayload(editor, {
      markdown: getImagesMarkdown(),
      ids: getImageIds(),
    });
    if (!payload) return;

    const intent = composerSubmitIntent({
      taskId: task.id,
      turnInFlight: isSending,
      waiting: queued.length,
    });
    if (intent === "hold") return;

    const options = {
      prompt: payload.prompt,
      mode: "auto" as const,
      executorProfileId: parseExecutorProfileId(run?.executor_label),
      imageIds: payload.imageIds,
      contextRefs: payload.contextRefs,
      selectedSkillIds: payload.selectedSkillIds,
    };
    setError(null);
    editor.clearWithSnapshot();
    clearUploadItems();
    try {
      if (intent === "queue") {
        await queueTaskMessage(task.id, options);
      } else {
        await sendTaskMessage(task.id, options);
      }
    } catch (cause) {
      editor.restore();
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [
    editor,
    isUploading,
    getImagesMarkdown,
    getImageIds,
    task.id,
    isSending,
    queued.length,
    run?.executor_label,
    clearUploadItems,
  ]);

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*"
        className="sr-only"
        onChange={(event) => handleFiles(event.target.files)}
      />
      {error ? (
        <p role="alert" className="px-1 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      <ImageUploadPreviewList
        items={uploadItems}
        t={t}
        onRetryUpload={handleRetryUpload}
        onRemoveUpload={handleRemoveUpload}
      />
      <div className="flex items-end gap-1 rounded-2xl border border-custom-border-200 bg-custom-background-100 py-1 pl-1 pr-1.5">
        <button
          type="button"
          title={t("edgeToolbarAttach")}
          aria-label={t("edgeToolbarAttach")}
          onClick={handleSelectFiles}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
        <div className="max-h-32 min-w-0 flex-1 overflow-y-auto py-1.5 text-[13px]">
          <PromptEditor
            handle={editor}
            placeholder={t("edgeToolbarReplyPlaceholder", {
              title: task.title || t("sessionUnresolved"),
            })}
            // One line, cut with an ellipsis at whatever width the row
            // leaves beside its buttons.
            placeholderClassName="right-0 truncate"
            onSubmit={() => void handleSend()}
          />
        </div>
        {accessory}
        <div className="shrink-0 pb-0.5">
          <SendButtonWithState
            editorHandle={editor}
            isSending={isSending}
            isStopping={isStopping}
            canSend
            canQueue
            isUploading={isUploading}
            onSend={() => void handleSend()}
            onCancel={onCancel}
            t={t}
          />
        </div>
      </div>
    </div>
  );
}
