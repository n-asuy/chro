
import { Button } from "@chro/ui/button";
import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { desktopFetch } from "@/lib/backend-client";
import type { ApprovalRecord } from "../types";
import type { TranslationFunction } from "@/i18n";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

const formatTimestamp = (input: string): string => {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return input;
  }
  return date.toLocaleString();
};

type ApprovalPanelProps = {
  approvals: Record<string, ApprovalRecord>;
  t: TranslationFunction;
  onApprovalUpdate?: () => void;
};

export function ApprovalPanel({
  approvals,
  t,
  onApprovalUpdate,
}: ApprovalPanelProps) {
  const [approvalActions, setApprovalActions] = useState<
    Record<string, boolean>
  >({});

  const approvalItems = useMemo(
    () =>
      Object.values(approvals).sort((a, b) => {
        const left = new Date(b.created_at).getTime();
        const right = new Date(a.created_at).getTime();
        return Number.isNaN(left) || Number.isNaN(right) ? 0 : left - right;
      }),
    [approvals],
  );

  const approvalsInFlight = useMemo(
    () => new Set(Object.keys(approvalActions)),
    [approvalActions],
  );

  const respondToApproval = useCallback(
    async (approvalId: string, action: "approve" | "deny") => {
      setApprovalActions((prev) => ({ ...prev, [approvalId]: true }));

      const payload = (() => {
        if (action === "approve") {
          return { status: "approved" };
        }
        let reason: string | null = null;
        if (typeof window !== "undefined") {
          const promptInput = window.prompt(t("approvalReasonPrompt")) ?? "";
          const trimmed = promptInput.trim();
          reason = trimmed.length > 0 ? trimmed : null;
        }
        return { status: "denied", reason };
      })();

      try {
        await desktopFetch(
          `/rpc/approvals/${encodeURIComponent(approvalId)}/respond`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        onApprovalUpdate?.();
      } catch (error) {
        console.error("Failed to update approval", error);
      } finally {
        setApprovalActions((prev) => {
          const next = { ...prev };
          delete next[approvalId];
          return next;
        });
      }
    },
    [onApprovalUpdate, t],
  );

  const renderApprovalCard = (approval: ApprovalRecord) => {
    const approvalStatus = approval.status.status;
    const badgeTone = (() => {
      switch (approvalStatus) {
        case "approved":
          return "border-emerald-200 bg-emerald-50 text-emerald-800";
        case "denied":
          return "border-red-200 bg-red-50 text-red-700";
        case "timed_out":
          return "border-amber-200 bg-amber-50 text-amber-800";
        default:
          return "border-blue-200 bg-blue-50 text-blue-800";
      }
    })();

    const statusLabel = (() => {
      switch (approvalStatus) {
        case "approved":
          return t("statusSuccess");
        case "denied":
          return t("statusDenied");
        case "timed_out":
          return t("statusTimedOut");
        default:
          return t("statusPending");
      }
    })();

    const toolInput = (() => {
      try {
        return JSON.stringify(approval.tool_input, null, 2);
      } catch {
        return String(approval.tool_input ?? "");
      }
    })();

    const pending = approvalStatus === "pending";
    const loading = approvalsInFlight.has(approval.id);

    return (
      <div
        key={approval.id}
        className="rounded-lg border border-border/50 bg-background/80 p-3 text-sm"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-foreground">
              {approval.tool_name}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatTimestamp(approval.created_at)}
            </p>
          </div>
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase",
              badgeTone,
            )}
          >
            {statusLabel}
          </span>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          <p className="font-semibold">{t("approvalToolInputLabel")}</p>
          {toolInput ? (
            <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-muted/30 p-2 text-[11px] text-foreground/90">
              {toolInput}
            </pre>
          ) : (
            <p className="mt-1 text-muted-foreground/80">—</p>
          )}
          {pending ? (
            <p className="mt-2">
              {t("pendingApprovalMessage", {
                timeout: formatTimestamp(approval.timeout_at),
              })}
            </p>
          ) : null}
          {approvalStatus === "denied" && approval.status.reason ? (
            <p className="mt-2 text-destructive">
              {t("deniedReasonLabel")}: {approval.status.reason}
            </p>
          ) : null}
        </div>
        {pending && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={loading}
              onClick={() => void respondToApproval(approval.id, "approve")}
            >
              {loading ? t("loadingIndicator") : t("approveButtonLabel")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => void respondToApproval(approval.id, "deny")}
            >
              {t("denyButtonLabel")}
            </Button>
          </div>
        )}
      </div>
    );
  };

  if (approvalItems.length === 0) {
    return null;
  }

  return (
    <div className="border-b border-border/40 bg-muted/20 px-4 py-4">
      <div className="space-y-2 rounded-lg border border-border/60 bg-background/70 p-3">
        {approvalItems.map((approval) => renderApprovalCard(approval))}
      </div>
    </div>
  );
}
