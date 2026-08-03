import { type TranslationKey, useLanguage } from "@/i18n";
import { cn } from "@chro/ui/utils";
import { memo, useCallback, useMemo, useState } from "react";
import type {
  McpApprovalDecision,
  McpApprovalParam,
  McpApprovalPrompt,
} from "../utils/mcp-approval-mapping";
import { type AskUserAnswer, AskUserQuestions } from "./ask-user-questions";

interface McpToolApprovalProps {
  approvalId: string;
  prompt: McpApprovalPrompt;
  onDecide: (decision: McpApprovalDecision) => void;
}

const QUESTION_ID = "mcp-approval";

const OPTION_LABEL: Record<McpApprovalDecision, TranslationKey> = {
  allow: "mcpApprovalAllow",
  allow_session: "mcpApprovalAllowSession",
  allow_always: "mcpApprovalAllowAlways",
  deny: "mcpApprovalDeny",
};

const OPTION_HINT: Record<McpApprovalDecision, TranslationKey | null> = {
  allow: "mcpApprovalAllowHint",
  allow_session: null,
  allow_always: "mcpApprovalAllowAlwaysHint",
  deny: null,
};

/**
 * Approval for an MCP tool call the agent server is blocked on. It is a
 * one-question decision, so it reuses the question panel and adds the context
 * the decision needs: which server is asking, and with what arguments.
 */
export const McpToolApproval = memo(function McpToolApproval({
  approvalId,
  prompt,
  onDecide,
}: McpToolApprovalProps) {
  const { t } = useLanguage();
  // Keyed by approval rather than a boolean so the next approval re-enables the
  // panel without an effect-driven reset.
  const [decidedApprovalId, setDecidedApprovalId] = useState<string | null>(
    null,
  );
  const isSubmitting = decidedApprovalId === approvalId;

  const handleComplete = useCallback(
    (answers: Record<string, AskUserAnswer>) => {
      if (isSubmitting) return;
      const decision = answers[QUESTION_ID]?.selectedIds[0] as
        | McpApprovalDecision
        | undefined;
      if (!decision) return;
      setDecidedApprovalId(approvalId);
      onDecide(decision);
    },
    [isSubmitting, approvalId, onDecide],
  );

  const items = useMemo(
    () => [
      {
        id: QUESTION_ID,
        title: prompt.message,
        header: prompt.title
          ? `${prompt.title} · ${prompt.server}`
          : prompt.server,
        headerAccessory: <RiskBadge riskLevel={prompt.riskLevel} />,
        detail:
          prompt.params.length > 0 ? (
            <ParamTable params={prompt.params} />
          ) : undefined,
        // An approval has to be answered: skipping it would leave the agent
        // blocked with nothing on screen.
        skippable: false,
        allowOther: false,
        options: prompt.options.map((decision) => {
          const hint = OPTION_HINT[decision];
          return {
            id: decision,
            title: t(OPTION_LABEL[decision]),
            description: hint ? t(hint) : undefined,
            tone: decision === "deny" ? ("muted" as const) : undefined,
          };
        }),
      },
    ],
    [prompt, t],
  );

  return (
    <AskUserQuestions
      key={approvalId}
      questions={items}
      onComplete={handleComplete}
      disabled={isSubmitting}
      className="mb-2"
    />
  );
});

/** Only shown when the server flags the call as more than routine. */
function RiskBadge({ riskLevel }: { riskLevel?: string }) {
  const { t } = useLanguage();
  if (!riskLevel || riskLevel === "low") return null;
  return (
    <span className="inline-flex items-center rounded border border-destructive/35 px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-destructive">
      {t("mcpApprovalElevatedRisk")}
    </span>
  );
}

/**
 * What the tool is about to do. Multi-line values (code, mostly) get a block of
 * their own so they stay readable instead of collapsing into a table cell.
 */
function ParamTable({ params }: { params: McpApprovalParam[] }) {
  return (
    <div className="mb-2.5 overflow-hidden rounded-lg border border-border bg-muted/30">
      {params.map((param, index) => {
        const isBlock = param.value.includes("\n");
        return (
          <div
            key={param.label}
            className={cn(
              index > 0 && "border-t border-border",
              isBlock
                ? "flex flex-col gap-0.5 px-2.5 py-1.5"
                : "flex gap-2.5 px-2.5 py-1.5",
            )}
          >
            {isBlock ? (
              <>
                <span className="text-xs text-muted-foreground">
                  {param.label}
                </span>
                <pre className="m-0 max-h-40 overflow-auto whitespace-pre font-mono text-[11px] leading-relaxed text-foreground">
                  {param.value}
                </pre>
              </>
            ) : (
              <>
                <span className="w-24 shrink-0 text-xs text-muted-foreground">
                  {param.label}
                </span>
                <span className="min-w-0 break-words text-xs text-foreground">
                  {param.value}
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
