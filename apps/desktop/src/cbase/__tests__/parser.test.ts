import { describe, expect, it } from "vitest";
import { LensParseError, parseLens } from "../parser";

const MINIMAL_LENS = `
version: 1
name: Tasks
dataset:
  include:
    - "tasks/**/*.md"
properties:
  p_title:
    key: title
    type: text
views:
  - id: v_table
    name: Table
    type: table
`;

describe("parseLens", () => {
  it("parses minimal valid lens", () => {
    const result = parseLens(MINIMAL_LENS);
    expect(result.version).toBe(1);
    expect(result.name).toBe("Tasks");
    expect(result.dataset.include).toEqual(["tasks/**/*.md"]);
    expect(result.properties.p_title.key).toBe("title");
    expect(result.properties.p_title.type).toBe("text");
    expect(result.views).toHaveLength(1);
    expect(result.views[0].id).toBe("v_table");
    expect(result.views[0].default).toBe(true); // auto-set
  });

  it("parses full lens with all features", () => {
    const yaml = `
version: 1
name: Project Tasks
description: All project tasks
dataset:
  include:
    - "tasks/**/*.md"
    - "issues/**/*.md"
  exclude:
    - "templates/**"
properties:
  p_title:
    key: title
    type: text
    required: true
  p_status:
    key: status
    type: select
    options: [todo, doing, done]
    default: todo
  p_priority:
    key: priority
    type: number
  p_done:
    key: done
    type: checkbox
  p_tags:
    key: tags
    type: multi_select
filters:
  - property: p_status
    op: "!="
    value: cancelled
sort:
  - by: p_priority
    dir: desc
views:
  - id: v_all
    name: All Tasks
    type: table
    default: true
    table:
      columns: [p_title, p_status, p_priority, p_done, p_tags]
      column_widths:
        p_title: 300
        p_status: 120
  - id: v_active
    name: Active
    type: table
    filters:
      - property: p_done
        op: "="
        value: false
    sort:
      - by: p_priority
        dir: asc
    limit: 50
template:
  folder: "tasks/"
  filename: "{{date:YYYY-MM-DD}}-{{slug(p_title)}}.md"
  frontmatter:
    status: todo
    done: false
  body: "# New Task\\n"
`;
    const result = parseLens(yaml);
    expect(result.name).toBe("Project Tasks");
    expect(result.description).toBe("All project tasks");
    expect(result.dataset.include).toHaveLength(2);
    expect(result.dataset.exclude).toEqual(["templates/**"]);
    expect(Object.keys(result.properties)).toHaveLength(5);
    expect(result.filters).toHaveLength(1);
    expect(result.sort).toHaveLength(1);
    expect(result.views).toHaveLength(2);
    expect(result.views[0].default).toBe(true);
    expect(result.views[1].limit).toBe(50);
    expect(result.template?.folder).toBe("tasks/");
    expect(result.template?.filename).toBe(
      "{{date:YYYY-MM-DD}}-{{slug(p_title)}}.md",
    );
  });

  it("rejects invalid YAML", () => {
    expect(() => parseLens("{{invalid")).toThrow(LensParseError);
  });

  it("rejects missing version", () => {
    expect(() => parseLens("name: Test")).toThrow(/version/);
  });

  it("rejects unsupported version", () => {
    expect(() => parseLens("version: 2\nname: Test")).toThrow(/version/);
  });

  it("rejects missing name", () => {
    expect(() => parseLens("version: 1\ndataset:\n  include: ['*']")).toThrow(
      /name/,
    );
  });

  it("rejects missing dataset", () => {
    expect(() =>
      parseLens("version: 1\nname: T\nproperties: {}\nviews: []"),
    ).toThrow(/dataset/);
  });

  it("rejects empty include", () => {
    const yaml = `
version: 1
name: T
dataset:
  include: []
properties:
  p: { key: k, type: text }
views:
  - id: v
    name: V
    type: table
`;
    expect(() => parseLens(yaml)).toThrow(/include/);
  });

  it("rejects invalid property type", () => {
    const yaml = `
version: 1
name: T
dataset:
  include: ["*.md"]
properties:
  p:
    key: k
    type: invalid_type
views:
  - id: v
    name: V
    type: table
`;
    expect(() => parseLens(yaml)).toThrow(/invalid_type/);
  });

  it("rejects unsupported view type", () => {
    const yaml = `
version: 1
name: T
dataset:
  include: ["*.md"]
properties:
  p:
    key: k
    type: text
views:
  - id: v
    name: V
    type: board
`;
    expect(() => parseLens(yaml)).toThrow(/board/);
  });

  it("parses compound filters", () => {
    const yaml = `
version: 1
name: T
dataset:
  include: ["*.md"]
properties:
  p_a: { key: a, type: text }
  p_b: { key: b, type: number }
filters:
  - and:
    - property: p_a
      op: "!="
      value: ""
    - or:
      - property: p_b
        op: ">"
        value: 0
      - property: p_b
        op: is_empty
views:
  - id: v
    name: V
    type: table
`;
    const result = parseLens(yaml);
    expect(result.filters).toHaveLength(1);
    const f = result.filters![0];
    expect("and" in f).toBe(true);
  });

  it("rejects filters that reference unknown properties", () => {
    const yaml = `
version: 1
name: T
dataset:
  include: ["*.md"]
properties:
  p_title: { key: title, type: text }
filters:
  - property: p_missing
    op: "="
    value: test
views:
  - id: v
    name: V
    type: table
`;
    expect(() => parseLens(yaml)).toThrow(/unknown property/);
  });

  it("rejects sort specs that reference unknown properties", () => {
    const yaml = `
version: 1
name: T
dataset:
  include: ["*.md"]
properties:
  p_title: { key: title, type: text }
sort:
  - by: p_missing
    dir: asc
views:
  - id: v
    name: V
    type: table
`;
    expect(() => parseLens(yaml)).toThrow(/unknown property/);
  });

  it("rejects table columns that reference unknown properties", () => {
    const yaml = `
version: 1
name: T
dataset:
  include: ["*.md"]
properties:
  p_title: { key: title, type: text }
views:
  - id: v
    name: V
    type: table
    table:
      columns: [p_title, p_missing]
`;
    expect(() => parseLens(yaml)).toThrow(/unknown property/);
  });

  it("auto-generates table columns from properties when not specified", () => {
    const result = parseLens(MINIMAL_LENS);
    expect(result.views[0].table?.columns).toEqual(["p_title"]);
  });
});
