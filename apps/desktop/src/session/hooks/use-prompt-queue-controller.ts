import { useCallback, useEffect, useRef, useState } from "react";
import type { PreparedPromptPayload } from "./use-single-session-controller";

const PENDING_QUEUE_KEY = "__pending__";
const EMPTY_PROMPT_QUEUE: QueuedPromptItem[] = [];

const toSingleQueue = (
  queue: QueuedPromptItem[] | undefined,
): QueuedPromptItem[] => {
  if (!queue || queue.length === 0) {
    return EMPTY_PROMPT_QUEUE;
  }
  return [queue[queue.length - 1]];
};

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

type SubmitPrompt = (
  payload: PreparedPromptPayload,
  options?: {
    restoreOnError?: boolean;
  },
) => Promise<boolean>;

export type QueuedPromptItem = {
  id: string;
  prompt: string;
  imageIds: string[] | null;
  selectedSkillIds: string[];
  createdAt: number;
};

type UsePromptQueueControllerArgs = {
  activeTaskId: string | null;
  isSending: boolean;
  isSendingRef: { current: boolean };
  submitPrompt: SubmitPrompt;
  handleCancel: () => Promise<void> | void;
};

export function usePromptQueueController({
  activeTaskId,
  isSending,
  isSendingRef,
  submitPrompt,
  handleCancel,
}: UsePromptQueueControllerArgs) {
  const queueProcessingRef = useRef(false);
  const [queuedPromptsByTask, setQueuedPromptsByTask] = useState<
    Record<string, QueuedPromptItem[]>
  >({});
  const [blockedQueueByTask, setBlockedQueueByTask] = useState<
    Record<string, boolean>
  >({});

  const activeQueueKey = activeTaskId ?? PENDING_QUEUE_KEY;
  const activePromptQueue = toSingleQueue(queuedPromptsByTask[activeQueueKey]);
  const isActiveQueueBlocked = blockedQueueByTask[activeQueueKey] ?? false;

  const addToPromptQueue = useCallback(
    (queueKey: string, item: QueuedPromptItem) => {
      setQueuedPromptsByTask((prev) => ({
        ...prev,
        [queueKey]: [item],
      }));
    },
    [],
  );

  const removeFromPromptQueue = useCallback(
    (queueKey: string, itemId: string) => {
      setQueuedPromptsByTask((prev) => {
        const queue = prev[queueKey] ?? EMPTY_PROMPT_QUEUE;
        if (!queue.some((item) => item.id === itemId)) {
          return prev;
        }
        const next = { ...prev };
        delete next[queueKey];
        return next;
      });
    },
    [],
  );

  const popPromptQueueItem = useCallback(
    (queueKey: string, itemId: string): QueuedPromptItem | null => {
      let poppedItem: QueuedPromptItem | null = null;
      setQueuedPromptsByTask((prev) => {
        const queue = prev[queueKey] ?? EMPTY_PROMPT_QUEUE;
        const target = queue.find((item) => item.id === itemId);
        if (!target) {
          return prev;
        }
        poppedItem = target;
        const next = { ...prev };
        delete next[queueKey];
        return next;
      });
      return poppedItem;
    },
    [],
  );

  const prependPromptQueueItem = useCallback(
    (queueKey: string, item: QueuedPromptItem) => {
      setQueuedPromptsByTask((prev) => ({
        ...prev,
        [queueKey]: [item],
      }));
    },
    [],
  );

  const setQueueBlock = useCallback((queueKey: string, blocked: boolean) => {
    setBlockedQueueByTask((prev) => {
      if (blocked) {
        return {
          ...prev,
          [queueKey]: true,
        };
      }
      if (!prev[queueKey]) {
        return prev;
      }
      const next = { ...prev };
      delete next[queueKey];
      return next;
    });
  }, []);

  const clearQueueBlock = useCallback(
    (queueKey: string) => {
      setQueueBlock(queueKey, false);
    },
    [setQueueBlock],
  );

  const clearQueue = useCallback((queueKey: string) => {
    setQueuedPromptsByTask((prev) => {
      if (!prev[queueKey]) {
        return prev;
      }
      const next = { ...prev };
      delete next[queueKey];
      return next;
    });
    setBlockedQueueByTask((prev) => {
      if (!prev[queueKey]) {
        return prev;
      }
      const next = { ...prev };
      delete next[queueKey];
      return next;
    });
  }, []);

  useEffect(() => {
    if (!activeTaskId) {
      return;
    }
    setQueuedPromptsByTask((prev) => {
      const pendingItem = toSingleQueue(prev[PENDING_QUEUE_KEY])[0];
      if (!pendingItem) {
        return prev;
      }
      const next = { ...prev };
      const taskItem = toSingleQueue(next[activeTaskId])[0];
      next[activeTaskId] =
        taskItem && taskItem.createdAt > pendingItem.createdAt
          ? [taskItem]
          : [pendingItem];
      delete next[PENDING_QUEUE_KEY];
      return next;
    });
    setBlockedQueueByTask((prev) => {
      if (!prev[PENDING_QUEUE_KEY]) {
        return prev;
      }
      const next = { ...prev, [activeTaskId]: true };
      delete next[PENDING_QUEUE_KEY];
      return next;
    });
  }, [activeTaskId]);

  const processNextQueuedPrompt = useCallback(async () => {
    if (
      queueProcessingRef.current ||
      isSending ||
      isActiveQueueBlocked ||
      activePromptQueue.length === 0
    ) {
      return;
    }

    const firstQueueItem = activePromptQueue[0];
    if (!firstQueueItem) {
      return;
    }

    const queuedItem = popPromptQueueItem(activeQueueKey, firstQueueItem.id);
    if (!queuedItem) {
      return;
    }

    queueProcessingRef.current = true;
    try {
      const isSent = await submitPrompt(
        {
          prompt: queuedItem.prompt,
          imageIds: queuedItem.imageIds,
          selectedSkillIds: queuedItem.selectedSkillIds,
        },
        { restoreOnError: false },
      );
      if (!isSent) {
        setQueueBlock(activeQueueKey, true);
        prependPromptQueueItem(activeQueueKey, queuedItem);
      } else {
        clearQueueBlock(activeQueueKey);
      }
    } finally {
      queueProcessingRef.current = false;
    }
  }, [
    isSending,
    isActiveQueueBlocked,
    activePromptQueue,
    popPromptQueueItem,
    activeQueueKey,
    submitPrompt,
    setQueueBlock,
    prependPromptQueueItem,
    clearQueueBlock,
  ]);

  useEffect(() => {
    void processNextQueuedPrompt();
  }, [processNextQueuedPrompt]);

  const waitForStreamIdle = useCallback(
    async (timeoutMs = 3000) => {
      const startedAt = Date.now();
      while (isSendingRef.current) {
        if (Date.now() - startedAt >= timeoutMs) {
          return false;
        }
        await wait(100);
      }
      return true;
    },
    [isSendingRef],
  );

  const enqueueActivePrompt = useCallback(
    (item: QueuedPromptItem) => {
      addToPromptQueue(activeQueueKey, item);
    },
    [addToPromptQueue, activeQueueKey],
  );

  const clearActiveQueueBlock = useCallback(() => {
    clearQueueBlock(activeQueueKey);
  }, [activeQueueKey, clearQueueBlock]);

  const clearPendingQueue = useCallback(() => {
    clearQueue(PENDING_QUEUE_KEY);
  }, [clearQueue]);

  const removeActiveQueueItem = useCallback(
    (itemId: string) => {
      removeFromPromptQueue(activeQueueKey, itemId);
      clearQueueBlock(activeQueueKey);
    },
    [activeQueueKey, removeFromPromptQueue, clearQueueBlock],
  );

  const sendActiveQueueItemNow = useCallback(
    async (itemId: string) => {
      if (queueProcessingRef.current) {
        return;
      }

      const queuedItem = popPromptQueueItem(activeQueueKey, itemId);
      if (!queuedItem) {
        return;
      }

      queueProcessingRef.current = true;
      clearQueueBlock(activeQueueKey);
      try {
        if (isSendingRef.current) {
          await handleCancel();
          const isIdle = await waitForStreamIdle();
          if (!isIdle) {
            setQueueBlock(activeQueueKey, true);
            prependPromptQueueItem(activeQueueKey, queuedItem);
            return;
          }
        }

        const isSent = await submitPrompt(
          {
            prompt: queuedItem.prompt,
            imageIds: queuedItem.imageIds,
            selectedSkillIds: queuedItem.selectedSkillIds,
          },
          { restoreOnError: false },
        );
        if (!isSent) {
          setQueueBlock(activeQueueKey, true);
          prependPromptQueueItem(activeQueueKey, queuedItem);
          return;
        }

        clearQueueBlock(activeQueueKey);
      } finally {
        queueProcessingRef.current = false;
      }
    },
    [
      popPromptQueueItem,
      activeQueueKey,
      clearQueueBlock,
      isSendingRef,
      handleCancel,
      waitForStreamIdle,
      setQueueBlock,
      prependPromptQueueItem,
      submitPrompt,
    ],
  );

  return {
    activeQueueKey,
    activePromptQueue,
    isActiveQueueBlocked,
    enqueueActivePrompt,
    clearActiveQueueBlock,
    clearPendingQueue,
    removeActiveQueueItem,
    sendActiveQueueItemNow,
  };
}
