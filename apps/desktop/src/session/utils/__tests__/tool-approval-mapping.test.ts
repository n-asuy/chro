import type { TranslationFunction } from "@/i18n";
import en from "@/i18n/locales/en";
import ja from "@/i18n/locales/ja";
import { describe, expect, it } from "vitest";
import type { ApprovalRecord } from "../../types/api";
import { findPendingToolApproval } from "../mcp-approval-mapping";

const pending: ApprovalRecord = {
  id: "approval-one",
  task_run_id: "run-one",
  tool_name: "bash",
  tool_input: { command: "pwd" },
  created_at: "2026-11-19T00:00:00Z",
  timeout_at: "2026-11-19T01:00:00Z",
  status: { status: "pending" },
};

describe.each([
  ["en", en],
  ["ja", ja],
] as const)("command and file approvals (%s)", (_language, locale) => {
  const t: TranslationFunction = (key, replacements) =>
    Object.entries(replacements ?? {}).reduce(
      (text, [name, value]) => text.replace(`{${name}}`, String(value)),
      locale[key],
    );
  const find = (approvals: Record<string, ApprovalRecord>, runId: string) =>
    findPendingToolApproval(approvals, runId, t);
  it("offers an allow/deny decision using the forwarded request's identity", () => {
    expect(find({ request: pending }, "run-one")).toEqual({
      approvalId: "approval-one",
      prompt: {
        server: "bash",
        message: locale.cloudAllowTool.replace("{tool}", "bash"),
        params: [{ label: "command", value: "pwd" }],
        options: ["allow", "deny"],
      },
    });
  });
  it("does not ask for a decision on another run or a resolved request", () => {
    expect(find({ request: pending }, "another-run")).toBeNull();
    expect(
      find(
        { request: { ...pending, status: { status: "approved" } } },
        "run-one",
      ),
    ).toBeNull();
  });
  it("keeps question and MCP payloads on their specialized paths", () => {
    for (const tool_name of ["AskUserQuestion", "codex.mcp_tool_call"]) {
      expect(
        find({ request: { ...pending, tool_name } }, "run-one"),
      ).toBeNull();
    }
  });
  it("still allows a tool approval whose CLI supplies no argument payload", () => {
    expect(
      find({ request: { ...pending, tool_input: null } }, "run-one")?.prompt
        .params,
    ).toEqual([]);
  });
});
