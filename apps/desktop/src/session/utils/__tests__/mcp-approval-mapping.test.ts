import { describe, expect, it } from "vitest";
import type { ApprovalRecord } from "../../types/api";
import {
  MCP_APPROVAL_TOOL_NAME,
  findPendingMcpApproval,
  mcpApprovalResponseBody,
  parseMcpApprovalPrompt,
} from "../mcp-approval-mapping";

/** Payload as the executor serializes it, from a real connector approval. */
const promptInput = {
  server: "node_repl",
  title: "Computer Use",
  message: 'Allow Computer Use to use "Chro"?',
  risk_level: "low",
  params: [{ label: "App", value: "Chro" }],
  options: ["allow", "allow_session", "allow_always", "deny"],
};

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "approval-1",
    task_run_id: "run-1",
    tool_name: MCP_APPROVAL_TOOL_NAME,
    tool_input: promptInput,
    created_at: "2026-08-01T00:00:00Z",
    timeout_at: "2026-08-01T01:00:00Z",
    status: { status: "pending" },
    ...overrides,
  };
}

describe("parseMcpApprovalPrompt", () => {
  it("reads a connector approval payload", () => {
    expect(parseMcpApprovalPrompt(promptInput)).toEqual({
      server: "node_repl",
      title: "Computer Use",
      message: 'Allow Computer Use to use "Chro"?',
      riskLevel: "low",
      params: [{ label: "App", value: "Chro" }],
      options: ["allow", "allow_session", "allow_always", "deny"],
    });
  });

  it("keeps only decisions this build knows how to answer", () => {
    const prompt = parseMcpApprovalPrompt({
      ...promptInput,
      options: ["allow", "allow_via_some_future_mode", "deny"],
    });

    expect(prompt?.options).toEqual(["allow", "deny"]);
  });

  it("drops params that are not label/value strings", () => {
    const prompt = parseMcpApprovalPrompt({
      ...promptInput,
      params: [
        { label: "App", value: "Chro" },
        { label: "Count", value: 3 },
        "not an object",
        null,
      ],
    });

    expect(prompt?.params).toEqual([{ label: "App", value: "Chro" }]);
  });

  it("rejects payloads that cannot be answered", () => {
    expect(parseMcpApprovalPrompt(null)).toBeNull();
    expect(parseMcpApprovalPrompt("nope")).toBeNull();
    expect(parseMcpApprovalPrompt({ ...promptInput, message: 42 })).toBeNull();
    expect(parseMcpApprovalPrompt({ ...promptInput, server: null })).toBeNull();
    expect(
      parseMcpApprovalPrompt({ ...promptInput, options: [] }),
      "no options means no way to answer",
    ).toBeNull();
  });
});

describe("findPendingMcpApproval", () => {
  it("finds the pending approval belonging to the run", () => {
    const found = findPendingMcpApproval(
      {
        a: approval({ id: "other-run", task_run_id: "run-2" }),
        b: approval({ id: "wanted" }),
      },
      "run-1",
    );

    expect(found?.approvalId).toBe("wanted");
    expect(found?.prompt.server).toBe("node_repl");
  });

  it("ignores resolved approvals, other tools, and unusable payloads", () => {
    const resolved = approval({ status: { status: "approved" } });
    const otherTool = approval({ tool_name: "AskUserQuestion" });
    const malformed = approval({ tool_input: { server: "node_repl" } });

    expect(
      findPendingMcpApproval(
        { a: resolved, b: otherTool, c: malformed },
        "run-1",
      ),
    ).toBeNull();
  });

  it("returns nothing without an active run", () => {
    expect(findPendingMcpApproval({ a: approval() }, null)).toBeNull();
  });
});

describe("mcpApprovalResponseBody", () => {
  it("sends every allow variant as approved, carrying which one", () => {
    expect(mcpApprovalResponseBody("allow")).toEqual({
      status: { status: "approved" },
      answers: { decision: "allow" },
    });
    expect(mcpApprovalResponseBody("allow_session")).toEqual({
      status: { status: "approved" },
      answers: { decision: "allow_session" },
    });
    expect(mcpApprovalResponseBody("allow_always")).toEqual({
      status: { status: "approved" },
      answers: { decision: "allow_always" },
    });
  });

  it("sends a denial as denied", () => {
    expect(mcpApprovalResponseBody("deny")).toEqual({
      status: { status: "denied" },
      answers: { decision: "deny" },
    });
  });
});
