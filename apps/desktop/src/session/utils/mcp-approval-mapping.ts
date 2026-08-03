import type { ApprovalRecord } from "../types/api";

/**
 * Mapping for MCP tool-call approvals raised by the agent server.
 *
 * The executor shapes the prompt before it reaches the approval record, so this
 * module only validates the payload and turns a chosen decision back into a
 * response body. Decision ids are the contract with the executor; labels are
 * presentation and live in the locale files.
 */

/** Tool name the executor records on an MCP tool-call approval. */
export const MCP_APPROVAL_TOOL_NAME = "codex.mcp_tool_call";

/** Key the chosen decision travels under in the approval answers map. */
const DECISION_KEY = "decision";

export const MCP_APPROVAL_DECISIONS = [
  "allow",
  "allow_session",
  "allow_always",
  "deny",
] as const;

export type McpApprovalDecision = (typeof MCP_APPROVAL_DECISIONS)[number];

export interface McpApprovalParam {
  label: string;
  value: string;
}

export interface McpApprovalPrompt {
  server: string;
  title?: string;
  message: string;
  riskLevel?: string;
  params: McpApprovalParam[];
  options: McpApprovalDecision[];
}

function isDecision(value: unknown): value is McpApprovalDecision {
  return MCP_APPROVAL_DECISIONS.includes(value as McpApprovalDecision);
}

function readParams(value: unknown): McpApprovalParam[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { label, value: paramValue } = entry as Record<string, unknown>;
    if (typeof label !== "string" || typeof paramValue !== "string") return [];
    return [{ label, value: paramValue }];
  });
}

/**
 * Returns `null` for anything that is not a usable prompt. A malformed payload
 * must not render a decision the user cannot understand, and an empty option
 * list would leave them with no way to answer.
 */
export function parseMcpApprovalPrompt(
  toolInput: unknown,
): McpApprovalPrompt | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const input = toolInput as Record<string, unknown>;

  const { server, message, title, risk_level: riskLevel } = input;
  if (typeof server !== "string" || typeof message !== "string") return null;

  const options = Array.isArray(input.options)
    ? input.options.filter(isDecision)
    : [];
  if (options.length === 0) return null;

  return {
    server,
    title: typeof title === "string" && title.length > 0 ? title : undefined,
    message,
    riskLevel: typeof riskLevel === "string" ? riskLevel : undefined,
    params: readParams(input.params),
    options,
  };
}

/** The one pending MCP approval for a run, or null. */
export function findPendingMcpApproval(
  approvals: Record<string, ApprovalRecord>,
  taskRunId: string | null,
): { approvalId: string; prompt: McpApprovalPrompt } | null {
  if (!taskRunId) return null;
  for (const approval of Object.values(approvals)) {
    if (approval.task_run_id !== taskRunId) continue;
    if (approval.tool_name !== MCP_APPROVAL_TOOL_NAME) continue;
    if (approval.status.status !== "pending") continue;
    const prompt = parseMcpApprovalPrompt(approval.tool_input);
    if (prompt) return { approvalId: approval.id, prompt };
  }
  return null;
}

export function isApprovingDecision(decision: McpApprovalDecision): boolean {
  return decision !== "deny";
}

/**
 * Body for `POST /rpc/approvals/{id}/respond`. The decision always rides in
 * `answers` because the executor needs to tell "allow once" from "allow for the
 * session"; `status` carries the coarse outcome for the audit record.
 */
export function mcpApprovalResponseBody(decision: McpApprovalDecision): {
  status: { status: "approved" } | { status: "denied" };
  answers: Record<string, string>;
} {
  return {
    status: isApprovingDecision(decision)
      ? { status: "approved" }
      : { status: "denied" },
    answers: { [DECISION_KEY]: decision },
  };
}
