import { useLanguage } from "@/i18n";
import { desktopFetch } from "@/lib/backend-client";
import { useCallback, useEffect, useMemo } from "react";
import {
  type PendingUserQuestions,
  QUESTIONS_SKIPPED_MESSAGE,
  type UserQuestion,
  useUserQuestionStore,
} from "../state/user-question-store";
import type { ApprovalRecord } from "../types/api";
import {
  type McpApprovalDecision,
  type McpApprovalPrompt,
  findPendingMcpApproval,
  findPendingToolApproval,
  mcpApprovalResponseBody,
} from "../utils/mcp-approval-mapping";

const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

interface UseSessionApprovalsArgs {
  /** Approval records from the session's conversation stream. */
  approvals: Record<string, ApprovalRecord>;
  /** The run whose approvals are answered here. */
  taskRunId: string | null;
}

export interface UseSessionApprovalsResult {
  /** The AskUserQuestion set the agent is blocked on, or null. */
  pendingQuestions: PendingUserQuestions | null;
  answerQuestions: (answers: Record<string, string>) => Promise<void>;
  skipQuestions: () => Promise<void>;
  /** The MCP tool call the agent is blocked on, or null. */
  pendingMcpApproval: { approvalId: string; prompt: McpApprovalPrompt } | null;
  decideMcpApproval: (decision: McpApprovalDecision) => Promise<void>;
}

function respondToApproval(
  approvalId: string,
  body: unknown,
): Promise<unknown> {
  return desktopFetch(
    `/rpc/approvals/${encodeURIComponent(approvalId)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/**
 * What the agent of one run is waiting on, and how to answer it: an
 * AskUserQuestion set or an MCP tool approval, both answered through the
 * approvals respond RPC. Every surface that shows a session's pending input
 * (the session view, the edge toolbar's session panel) uses this, so they
 * answer the same way and share the locally recorded answers.
 */
export function useSessionApprovals({
  approvals,
  taskRunId,
}: UseSessionApprovalsArgs): UseSessionApprovalsResult {
  const pendingQuestions = useUserQuestionStore((s) =>
    taskRunId ? s.pendingQuestions.get(taskRunId) ?? null : null,
  );
  const setPendingQuestions = useUserQuestionStore(
    (s) => s.setPendingQuestions,
  );
  const setQuestionResult = useUserQuestionStore((s) => s.setResult);

  // Surface pending AskUserQuestion approvals from the stream as the
  // interactive question panel, and drop the panel once the approval resolves
  // (answered, denied, or timed out).
  useEffect(() => {
    if (!taskRunId) return;

    const pendingApproval = Object.values(approvals).find(
      (approval) =>
        approval.task_run_id === taskRunId &&
        approval.tool_name === ASK_USER_QUESTION_TOOL &&
        approval.status.status === "pending",
    );
    const questions = pendingApproval
      ? (pendingApproval.tool_input as { questions?: UserQuestion[] } | null)
          ?.questions ?? []
      : [];

    const store = useUserQuestionStore.getState();
    // An approval with a locally recorded result was already answered or
    // skipped — its stream record just hasn't flipped from "pending" yet.
    if (
      pendingApproval &&
      questions.length > 0 &&
      !store.results.has(pendingApproval.id)
    ) {
      const existing = store.pendingQuestions.get(taskRunId);
      if (existing?.toolUseId !== pendingApproval.id) {
        store.setPendingQuestions(taskRunId, {
          taskRunId,
          toolUseId: pendingApproval.id,
          questions,
        });
      }
    } else {
      store.clearPendingQuestions(taskRunId);
    }
  }, [approvals, taskRunId]);

  const answerQuestions = useCallback(
    async (answers: Record<string, string>) => {
      if (!pendingQuestions || !taskRunId) return;
      const { toolUseId } = pendingQuestions;
      try {
        // Store the result first so the answered row renders immediately.
        setQuestionResult(toolUseId, answers);
        await respondToApproval(toolUseId, {
          status: { status: "approved" },
          answers,
        });
        setPendingQuestions(taskRunId, null);
      } catch (error) {
        console.error("[answerQuestions] Failed to submit answer", error);
      }
    },
    [pendingQuestions, taskRunId, setQuestionResult, setPendingQuestions],
  );

  const skipQuestions = useCallback(async () => {
    if (!pendingQuestions || !taskRunId) return;
    const { toolUseId } = pendingQuestions;
    try {
      setQuestionResult(toolUseId, { error: QUESTIONS_SKIPPED_MESSAGE });
      await respondToApproval(toolUseId, {
        status: { status: "denied", reason: QUESTIONS_SKIPPED_MESSAGE },
      });
      setPendingQuestions(taskRunId, null);
    } catch (error) {
      console.error("[skipQuestions] Failed to skip question", error);
    }
  }, [pendingQuestions, taskRunId, setQuestionResult, setPendingQuestions]);

  // MCP tool approvals need no store: the approval record in the stream is
  // already the source of truth, and it clears itself once resolved.
  const { t } = useLanguage();
  const pendingMcpApproval = useMemo(
    () =>
      findPendingMcpApproval(approvals, taskRunId) ??
      findPendingToolApproval(approvals, taskRunId, t),
    [approvals, taskRunId, t],
  );

  const decideMcpApproval = useCallback(
    async (decision: McpApprovalDecision) => {
      if (!pendingMcpApproval) return;
      try {
        await respondToApproval(
          pendingMcpApproval.approvalId,
          mcpApprovalResponseBody(decision),
        );
      } catch (error) {
        console.error("[decideMcpApproval] Failed to submit decision", error);
      }
    },
    [pendingMcpApproval],
  );

  return {
    pendingQuestions,
    answerQuestions,
    skipQuestions,
    pendingMcpApproval,
    decideMcpApproval,
  };
}
