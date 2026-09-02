import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Frontmatter } from "../../../lib/frontmatter";
import { FrontmatterEditor } from "../frontmatter-editor";

/**
 * Static render only: what matters here is which values the panel offers as
 * editable. A value the panel cannot represent must render read-only, because
 * every editable control writes its draft back into the document.
 */
function render(frontmatter: Frontmatter): string {
  return renderToStaticMarkup(
    <FrontmatterEditor
      frontmatter={frontmatter}
      onChange={() => {}}
      viewMode="ui"
      onViewModeChange={() => {}}
    />,
  );
}

const nested: Frontmatter = {
  name: "reference-server-inventory",
  metadata: {
    category: "infrastructure",
    servers: [{ host: "etvox", free: true }],
  },
};

describe("FrontmatterEditor nested properties", () => {
  it("renders a nested map as YAML instead of a stringified object", () => {
    const markup = render(nested);

    expect(markup).not.toContain("[object Object]");
    expect(markup).toContain("category: infrastructure");
    expect(markup).toContain("- host: etvox");
  });

  it("renders a nested value read-only, outside any editable control", () => {
    const markup = render(nested);

    expect(markup).toMatch(/<pre[^>]*>category: infrastructure/);
    expect(markup).toContain("Nested (read-only)");
  });

  it("still renders scalar properties as editable controls", () => {
    const markup = render(nested);

    expect(markup).toMatch(
      /<button[^>]*>reference-server-inventory<\/button>/,
    );
  });

  it("renders a list of scalars as tags", () => {
    const markup = render({ ports: [80, 443] });

    expect(markup).toContain("80");
    expect(markup).toContain("443");
    expect(markup).not.toContain("[object Object]");
  });
});
