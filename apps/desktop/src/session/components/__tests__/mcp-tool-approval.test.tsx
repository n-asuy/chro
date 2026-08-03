import { LanguageProvider } from "@/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { McpApprovalPrompt } from "../../utils/mcp-approval-mapping";
import { McpToolApproval } from "../mcp-tool-approval";

/**
 * Static render only: this checks that the prompt reaches the question panel
 * intact, which is where the two components meet. Interaction lives in
 * AskUserQuestions and is exercised through the app.
 */
function render(prompt: McpApprovalPrompt): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <McpToolApproval
        approvalId="approval-1"
        prompt={prompt}
        onDecide={() => {}}
      />
    </LanguageProvider>,
  );
}

const connectorPrompt: McpApprovalPrompt = {
  server: "node_repl",
  title: "Computer Use",
  message: 'Allow Computer Use to use "Chro"?',
  riskLevel: "low",
  params: [{ label: "App", value: "Chro" }],
  options: ["allow", "allow_session", "allow_always", "deny"],
};

describe("McpToolApproval", () => {
  it("shows the question, its context, and every offered option", () => {
    const html = render(connectorPrompt);

    expect(html).toContain("Allow Computer Use to use &quot;Chro&quot;?");
    expect(html).toContain("Computer Use · node_repl");
    expect(html).toContain("App");
    expect(html).toContain("Chro");
    expect(html).toContain("Allow for this session");
    expect(html).toContain("Always allow");
    expect(html).toContain("Deny");
  });

  it("offers no way out other than the options", () => {
    const html = render(connectorPrompt);

    expect(html).not.toContain("Skip");
    expect(html).not.toContain("Describe in your own words");
  });

  it("flags only calls the server marks as riskier than routine", () => {
    expect(render(connectorPrompt)).not.toContain("Outside the sandbox");
    expect(render({ ...connectorPrompt, riskLevel: "high" })).toContain(
      "Outside the sandbox",
    );
  });

  it("renders a multi-line argument as its own block", () => {
    const html = render({
      ...connectorPrompt,
      params: [{ label: "code", value: "const a = 1;\nconsole.log(a);" }],
    });

    expect(html).toContain("<pre");
    expect(html).toContain("console.log(a);");
  });

  it("hides options the server did not offer", () => {
    const html = render({ ...connectorPrompt, options: ["allow", "deny"] });

    expect(html).toContain("Allow");
    expect(html).toContain("Deny");
    expect(html).not.toContain("Allow for this session");
    expect(html).not.toContain("Always allow");
  });
});
