import type {
  CbaseDefinition,
  CbaseFilter,
  CbaseProperty,
  CbasePropertyType,
  CbaseSort,
} from "./types";

export class QueryLanguageParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryLanguageParseError";
  }
}

type QueryLanguageType = "table" | "list" | "task" | "calendar";
type SourceNode =
  | { type: "tag"; value: string }
  | { type: "path"; value: string }
  | { type: "and"; left: SourceNode; right: SourceNode }
  | { type: "or"; left: SourceNode; right: SourceNode }
  | { type: "not"; child: SourceNode };

type WhereNode =
  | { type: "literal"; value: unknown }
  | { type: "field"; name: string }
  | { type: "call"; name: string; args: WhereNode[] }
  | {
      type: "binary";
      op: "and" | "or" | "=" | "!=" | "<" | ">" | "<=" | ">=";
      left: WhereNode;
      right: WhereNode;
    }
  | { type: "not"; expr: WhereNode };

type ComparisonOp = "=" | "!=" | "<" | ">" | "<=" | ">=";
type ComparisonBinaryNode = {
  type: "binary";
  op: ComparisonOp;
  left: WhereNode;
  right: WhereNode;
};

interface ParsedHeaderField {
  raw: string;
  alias?: string;
}

interface ParsedSortField {
  raw: string;
  dir: "asc" | "desc";
}

interface ParsedQueryLanguage {
  type: QueryLanguageType;
  fields: ParsedHeaderField[];
  source?: SourceNode;
  where: WhereNode[];
  sort: ParsedSortField[];
  limit?: number;
}

interface ParseQueryLanguageOptions {
  basePath?: string;
}

interface SourceToken {
  type: "tag" | "string" | "and" | "or" | "minus" | "lparen" | "rparen" | "eof";
  text: string;
}

interface WhereToken {
  type:
    | "ident"
    | "number"
    | "string"
    | "boolean"
    | "null"
    | "and"
    | "or"
    | "not"
    | "bang"
    | "op"
    | "comma"
    | "lparen"
    | "rparen"
    | "eof";
  text: string;
  value?: unknown;
}

const QUERY_LANGUAGE_START = /^(TABLE|LIST|TASK|CALENDAR)\b/i;
const CLAUSE_START =
  /^(TABLE|LIST|TASK|CALENDAR|FROM|WHERE|SORT|LIMIT|GROUP BY|FLATTEN)\b/i;
const SIMPLE_FIELD_REF = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function resolveDefaultDatasetInclude(basePath?: string): string[] {
  const normalizedPath = (basePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  if (!normalizedPath) return ["**/*.md"];

  const index = normalizedPath.lastIndexOf("/");
  if (index < 0) return ["**/*.md"];

  const folder = normalizedPath.slice(0, index);
  return folder ? [`${folder}/**/*.md`] : ["**/*.md"];
}

export function looksLikeQueryLanguage(content: string): boolean {
  const normalized = stripQueryFence(content).trim();
  if (!normalized) return false;

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => stripInlineComment(line).trim())
    .filter(Boolean);

  if (lines.length === 0) return false;
  return QUERY_LANGUAGE_START.test(lines[0] ?? "");
}

export function parseQueryLanguageToCbaseDefinition(
  rawQuery: string,
  meta?: { name?: string; description?: string },
  options?: ParseQueryLanguageOptions,
): CbaseDefinition {
  const parsed = parseQueryLanguage(rawQuery);
  if (parsed.type !== "table") {
    throw new QueryLanguageParseError(
      `Only TABLE queries are supported in .cbase for now (received ${parsed.type.toUpperCase()})`,
    );
  }

  const registry = new PropertyRegistry();
  const filters: CbaseFilter[] = [];

  if (parsed.source) {
    const sourceFilter = sourceNodeToFilter(parsed.source, registry);
    if (sourceFilter) filters.push(sourceFilter);
  }

  for (const where of parsed.where) {
    const whereFilter = whereNodeToFilter(where, registry);
    if (whereFilter) filters.push(whereFilter);
  }

  const sort: CbaseSort[] = parsed.sort.map((entry) => ({
    by: registry.ensure(entry.raw),
    dir: entry.dir,
  }));

  const tableColumns: string[] = [];
  for (const field of parsed.fields) {
    if (!SIMPLE_FIELD_REF.test(field.raw)) continue;
    const id = registry.ensure(field.raw);
    tableColumns.push(id);
  }

  if (Object.keys(registry.properties).length === 0) {
    registry.ensure("file.name", "text");
  }

  const resolvedColumns =
    tableColumns.length > 0 ? tableColumns : Object.keys(registry.properties);
  const datasetInclude =
    parsed.source != null
      ? ["**/*.md"]
      : resolveDefaultDatasetInclude(options?.basePath);

  return {
    version: 1,
    name: meta?.name ?? "Query Language",
    description: meta?.description,
    dataset: {
      include: datasetInclude,
    },
    properties: registry.properties,
    filters: filters.length > 0 ? filters : undefined,
    sort: sort.length > 0 ? sort : undefined,
    views: [
      {
        id: "default",
        name: "All",
        type: "table",
        default: true,
        ...(parsed.limit != null ? { limit: parsed.limit } : {}),
        table: {
          columns: resolvedColumns,
        },
      },
    ],
  };
}

function parseQueryLanguage(raw: string): ParsedQueryLanguage {
  const query = stripQueryFence(raw).trim();
  if (!query) {
    throw new QueryLanguageParseError("Query is empty");
  }

  const clauses = splitClauses(query);
  if (clauses.length === 0) {
    throw new QueryLanguageParseError("Query is empty");
  }

  const header = parseHeaderClause(clauses[0] ?? "");
  const parsed: ParsedQueryLanguage = {
    type: header.type,
    fields: header.fields,
    where: [],
    sort: [],
  };

  let seenFrom = false;
  let seenLimit = false;

  for (let i = 1; i < clauses.length; i++) {
    const clause = clauses[i] ?? "";

    if (/^FROM\b/i.test(clause)) {
      if (seenFrom) {
        throw new QueryLanguageParseError("Only one FROM clause is supported");
      }
      seenFrom = true;
      const sourceText = clause.replace(/^FROM\s+/i, "").trim();
      if (!sourceText) {
        throw new QueryLanguageParseError("FROM requires a source");
      }
      parsed.source = parseSourceExpression(sourceText);
      continue;
    }

    if (/^WHERE\b/i.test(clause)) {
      const exprText = clause.replace(/^WHERE\s+/i, "").trim();
      if (!exprText) {
        throw new QueryLanguageParseError("WHERE requires an expression");
      }
      parsed.where.push(parseWhereExpression(exprText));
      continue;
    }

    if (/^SORT\b/i.test(clause)) {
      const sortText = clause.replace(/^SORT\s+/i, "").trim();
      if (!sortText) {
        throw new QueryLanguageParseError("SORT requires at least one field");
      }
      parsed.sort.push(...parseSortFields(sortText));
      continue;
    }

    if (/^LIMIT\b/i.test(clause)) {
      if (seenLimit) {
        throw new QueryLanguageParseError("Only one LIMIT clause is supported");
      }
      seenLimit = true;
      const limitText = clause.replace(/^LIMIT\s+/i, "").trim();
      if (!/^\d+$/.test(limitText)) {
        throw new QueryLanguageParseError(
          "LIMIT currently supports only integer literals",
        );
      }
      parsed.limit = Number.parseInt(limitText, 10);
      continue;
    }

    if (/^GROUP\s+BY\b/i.test(clause)) {
      throw new QueryLanguageParseError(
        "GROUP BY is not supported in .cbase yet",
      );
    }

    if (/^FLATTEN\b/i.test(clause)) {
      throw new QueryLanguageParseError(
        "FLATTEN is not supported in .cbase yet",
      );
    }

    throw new QueryLanguageParseError(`Unsupported clause: ${clause}`);
  }

  return parsed;
}

function parseHeaderClause(clause: string): {
  type: QueryLanguageType;
  fields: ParsedHeaderField[];
} {
  const match = clause.match(/^(TABLE|LIST|TASK|CALENDAR)\b([\s\S]*)$/i);
  if (!match) {
    throw new QueryLanguageParseError(
      "Query must start with TABLE/LIST/TASK/CALENDAR",
    );
  }

  const type = match[1]!.toLowerCase() as QueryLanguageType;
  let rest = (match[2] ?? "").trim();

  if (/^WITHOUT\s+ID\b/i.test(rest)) {
    rest = rest.replace(/^WITHOUT\s+ID\b/i, "").trim();
  }

  if (type !== "table" && rest) {
    throw new QueryLanguageParseError(
      `${type.toUpperCase()} with custom fields is not supported in .cbase yet`,
    );
  }

  const fields =
    type === "table" && rest
      ? splitTopLevel(rest, ",").map(parseHeaderField)
      : [];

  return { type, fields };
}

function parseHeaderField(rawField: string): ParsedHeaderField {
  const text = rawField.trim();
  if (!text) {
    throw new QueryLanguageParseError("TABLE has an empty field");
  }

  const aliasMatch = text.match(/^(.*?)(?:\s+AS\s+)(.+)$/i);
  if (!aliasMatch) {
    return { raw: text };
  }

  const expr = aliasMatch[1]!.trim();
  const alias = unquote(aliasMatch[2]!.trim());
  return { raw: expr, alias };
}

function parseSortFields(raw: string): ParsedSortField[] {
  return splitTopLevel(raw, ",").map((part) => {
    const text = part.trim();
    if (!text) {
      throw new QueryLanguageParseError("SORT has an empty field entry");
    }

    const sortMatch = text.match(
      /^(.*?)(?:\s+(ASCENDING|DESCENDING|ASC|DESC))?$/i,
    );
    if (!sortMatch) {
      throw new QueryLanguageParseError(`Invalid SORT field: ${text}`);
    }

    const rawField = sortMatch[1]!.trim();
    if (!SIMPLE_FIELD_REF.test(rawField)) {
      throw new QueryLanguageParseError(
        `SORT currently supports only plain field references (got: ${rawField})`,
      );
    }

    const dirToken = sortMatch[2]?.toLowerCase();
    const dir =
      dirToken === "desc" || dirToken === "descending" ? "desc" : "asc";

    return {
      raw: rawField,
      dir,
    };
  });
}

function sourceNodeToFilter(
  node: SourceNode,
  registry: PropertyRegistry,
): CbaseFilter | null {
  switch (node.type) {
    case "tag": {
      const property = registry.ensure("tags", "multi_select");
      const normalizedTag = node.value.startsWith("#")
        ? node.value.slice(1)
        : node.value;

      return {
        or: [
          { property, op: "contains", value: normalizedTag },
          { property, op: "contains", value: `#${normalizedTag}` },
        ],
      };
    }
    case "path": {
      const path = node.value.replace(/^\/+|\/+$/g, "");
      if (!path) return null;

      const property = registry.ensure("file.path", "text");
      if (path.endsWith(".md")) {
        return { property, op: "=", value: path };
      }

      return {
        property,
        op: "starts_with",
        value: `${path}/`,
      };
    }
    case "not": {
      const child = sourceNodeToFilter(node.child, registry);
      if (!child) return null;
      return { not: child };
    }
    case "and": {
      const left = sourceNodeToFilter(node.left, registry);
      const right = sourceNodeToFilter(node.right, registry);
      if (left && right) return { and: [left, right] };
      return left ?? right;
    }
    case "or": {
      const left = sourceNodeToFilter(node.left, registry);
      const right = sourceNodeToFilter(node.right, registry);
      if (left && right) return { or: [left, right] };
      return left ?? right;
    }
  }
}

function parseSourceExpression(sourceText: string): SourceNode {
  if (sourceText.includes("[[") || /\boutgoing\s*\(/i.test(sourceText)) {
    throw new QueryLanguageParseError(
      "Link-based FROM sources are not supported in .cbase yet",
    );
  }

  const tokens = tokenizeSource(sourceText);
  let index = 0;

  const peek = () => tokens[index] ?? { type: "eof", text: "" };
  const consume = (type?: SourceToken["type"]): SourceToken => {
    const token = peek();
    if (type && token.type !== type) {
      throw new QueryLanguageParseError(
        `Expected ${type} in FROM source, got ${token.type}`,
      );
    }
    index += 1;
    return token;
  };

  const parsePrimary = (): SourceNode => {
    const token = peek();

    if (token.type === "string") {
      consume();
      return { type: "path", value: token.text };
    }

    if (token.type === "tag") {
      consume();
      return { type: "tag", value: token.text };
    }

    if (token.type === "lparen") {
      consume("lparen");
      const expr = parseOr();
      consume("rparen");
      return expr;
    }

    throw new QueryLanguageParseError(
      `Invalid FROM source token: '${token.text || token.type}'`,
    );
  };

  const parseUnary = (): SourceNode => {
    if (peek().type === "minus") {
      consume("minus");
      return { type: "not", child: parseUnary() };
    }
    return parsePrimary();
  };

  const parseAnd = (): SourceNode => {
    let left = parseUnary();
    while (peek().type === "and") {
      consume("and");
      left = { type: "and", left, right: parseUnary() };
    }
    return left;
  };

  const parseOr = (): SourceNode => {
    let left = parseAnd();
    while (peek().type === "or") {
      consume("or");
      left = { type: "or", left, right: parseAnd() };
    }
    return left;
  };

  const result = parseOr();
  if (peek().type !== "eof") {
    throw new QueryLanguageParseError(
      `Unexpected token in FROM source: '${peek().text || peek().type}'`,
    );
  }

  return result;
}

function tokenizeSource(text: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen", text: ch });
      i += 1;
      continue;
    }

    if (ch === ")") {
      tokens.push({ type: "rparen", text: ch });
      i += 1;
      continue;
    }

    if (ch === "-") {
      tokens.push({ type: "minus", text: ch });
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const [value, next] = readQuoted(text, i);
      tokens.push({ type: "string", text: value });
      i = next;
      continue;
    }

    if (ch === "#") {
      let j = i + 1;
      while (j < text.length && /[^\s()]/.test(text[j]!)) j += 1;
      tokens.push({ type: "tag", text: text.slice(i, j) });
      i = j;
      continue;
    }

    const andMatch = text.slice(i).match(/^AND\b/i);
    if (andMatch) {
      tokens.push({ type: "and", text: andMatch[0] });
      i += andMatch[0].length;
      continue;
    }

    const orMatch = text.slice(i).match(/^OR\b/i);
    if (orMatch) {
      tokens.push({ type: "or", text: orMatch[0] });
      i += orMatch[0].length;
      continue;
    }

    throw new QueryLanguageParseError(
      `Unsupported token in FROM source near: '${text.slice(i, i + 16)}'`,
    );
  }

  tokens.push({ type: "eof", text: "" });
  return tokens;
}

function parseWhereExpression(raw: string): WhereNode {
  const tokens = tokenizeWhere(raw);
  let index = 0;

  const peek = () => tokens[index] ?? { type: "eof", text: "" };
  const consume = (type?: WhereToken["type"]): WhereToken => {
    const token = peek();
    if (type && token.type !== type) {
      throw new QueryLanguageParseError(
        `Expected ${type} in WHERE expression, got ${token.type}`,
      );
    }
    index += 1;
    return token;
  };

  const parsePrimary = (): WhereNode => {
    const token = peek();

    if (token.type === "lparen") {
      consume("lparen");
      const expr = parseOr();
      consume("rparen");
      return expr;
    }

    if (token.type === "ident") {
      consume("ident");
      const fieldName = token.text;
      if (peek().type === "lparen") {
        consume("lparen");
        const args: WhereNode[] = [];
        if (peek().type !== "rparen") {
          while (true) {
            args.push(parseOr());
            if (peek().type === "comma") {
              consume("comma");
              continue;
            }
            break;
          }
        }
        consume("rparen");
        return { type: "call", name: fieldName, args };
      }
      return { type: "field", name: fieldName };
    }

    if (token.type === "number") {
      consume("number");
      return { type: "literal", value: token.value };
    }

    if (token.type === "string") {
      consume("string");
      return { type: "literal", value: token.value };
    }

    if (token.type === "boolean") {
      consume("boolean");
      return { type: "literal", value: token.value };
    }

    if (token.type === "null") {
      consume("null");
      return { type: "literal", value: null };
    }

    throw new QueryLanguageParseError(
      `Invalid WHERE token: '${token.text || token.type}'`,
    );
  };

  const parseComparison = (): WhereNode => {
    const left = parsePrimary();
    if (peek().type !== "op") return left;

    const operator = consume("op").text as "=" | "!=" | "<" | ">" | "<=" | ">=";
    const right = parsePrimary();

    return {
      type: "binary",
      op: operator,
      left,
      right,
    };
  };

  const parseNot = (): WhereNode => {
    const token = peek();
    if (token.type === "not" || token.type === "bang") {
      consume();
      return { type: "not", expr: parseNot() };
    }
    return parseComparison();
  };

  const parseAnd = (): WhereNode => {
    let left = parseNot();
    while (peek().type === "and") {
      consume("and");
      left = {
        type: "binary",
        op: "and",
        left,
        right: parseNot(),
      };
    }
    return left;
  };

  const parseOr = (): WhereNode => {
    let left = parseAnd();
    while (peek().type === "or") {
      consume("or");
      left = {
        type: "binary",
        op: "or",
        left,
        right: parseAnd(),
      };
    }
    return left;
  };

  const result = parseOr();
  if (peek().type !== "eof") {
    throw new QueryLanguageParseError(
      `Unexpected token in WHERE expression: '${peek().text || peek().type}'`,
    );
  }

  return result;
}

function tokenizeWhere(text: string): WhereToken[] {
  const tokens: WhereToken[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen", text: ch });
      i += 1;
      continue;
    }

    if (ch === ")") {
      tokens.push({ type: "rparen", text: ch });
      i += 1;
      continue;
    }

    if (ch === ",") {
      tokens.push({ type: "comma", text: ch });
      i += 1;
      continue;
    }

    if (ch === "!") {
      if (text[i + 1] === "=") {
        tokens.push({ type: "op", text: "!=" });
        i += 2;
      } else {
        tokens.push({ type: "bang", text: "!" });
        i += 1;
      }
      continue;
    }

    if (ch === "<" || ch === ">" || ch === "=") {
      if (text[i + 1] === "=") {
        tokens.push({ type: "op", text: `${ch}=` });
        i += 2;
      } else {
        tokens.push({ type: "op", text: ch });
        i += 1;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      const [value, next] = readQuoted(text, i);
      tokens.push({ type: "string", text: value, value });
      i = next;
      continue;
    }

    const numberMatch = text.slice(i).match(/^-?\d+(?:\.\d+)?/);
    if (numberMatch) {
      tokens.push({
        type: "number",
        text: numberMatch[0],
        value: Number(numberMatch[0]),
      });
      i += numberMatch[0].length;
      continue;
    }

    const identMatch = text.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.-]*/);
    if (identMatch) {
      const ident = identMatch[0];
      const upper = ident.toUpperCase();
      if (upper === "AND") {
        tokens.push({ type: "and", text: ident });
      } else if (upper === "OR") {
        tokens.push({ type: "or", text: ident });
      } else if (upper === "NOT") {
        tokens.push({ type: "not", text: ident });
      } else if (upper === "TRUE" || upper === "FALSE") {
        tokens.push({
          type: "boolean",
          text: ident,
          value: upper === "TRUE",
        });
      } else if (upper === "NULL") {
        tokens.push({ type: "null", text: ident, value: null });
      } else {
        tokens.push({ type: "ident", text: ident });
      }
      i += ident.length;
      continue;
    }

    throw new QueryLanguageParseError(
      `Unsupported token in WHERE expression near: '${text.slice(i, i + 16)}'`,
    );
  }

  tokens.push({ type: "eof", text: "" });
  return tokens;
}

function whereNodeToFilter(
  node: WhereNode,
  registry: PropertyRegistry,
): CbaseFilter | null {
  switch (node.type) {
    case "binary": {
      if (node.op === "and" || node.op === "or") {
        const left = whereNodeToFilter(node.left, registry);
        const right = whereNodeToFilter(node.right, registry);

        if (!left || !right) {
          return left ?? right;
        }

        return node.op === "and"
          ? { and: [left, right] }
          : { or: [left, right] };
      }

      if (!isComparisonBinaryNode(node)) {
        throw new QueryLanguageParseError(
          `Unsupported binary operator '${node.op}' in WHERE`,
        );
      }
      return comparisonToFilter(node, registry);
    }
    case "not": {
      const inner = whereNodeToFilter(node.expr, registry);
      if (!inner) return null;
      return { not: inner };
    }
    case "field": {
      const property = registry.ensure(node.name);
      return { property, op: "is_not_empty" };
    }
    case "call": {
      return functionCallToFilter(node, registry);
    }
    case "literal": {
      if (typeof node.value === "boolean") {
        if (node.value) return null;
        throw new QueryLanguageParseError(
          "WHERE false is not supported in .cbase yet",
        );
      }
      throw new QueryLanguageParseError(
        "WHERE literal expression is not supported without a field",
      );
    }
  }
}

function comparisonToFilter(
  node: ComparisonBinaryNode,
  registry: PropertyRegistry,
): CbaseFilter {
  const leftField = node.left.type === "field" ? node.left.name : null;
  const rightField = node.right.type === "field" ? node.right.name : null;
  const leftLiteral =
    node.left.type === "literal" ? node.left.value : undefined;
  const rightLiteral =
    node.right.type === "literal" ? node.right.value : undefined;

  if (leftField && rightField) {
    throw new QueryLanguageParseError(
      `WHERE comparison between two fields is not supported (${leftField} ${node.op} ${rightField})`,
    );
  }

  if (leftField && node.right.type === "literal") {
    return buildComparisonFilter(leftField, node.op, rightLiteral, registry);
  }

  if (rightField && node.left.type === "literal") {
    return buildComparisonFilter(
      rightField,
      reverseComparisonOp(node.op),
      leftLiteral,
      registry,
    );
  }

  throw new QueryLanguageParseError(
    "WHERE comparisons currently require one field and one literal",
  );
}

function isComparisonBinaryNode(node: WhereNode): node is ComparisonBinaryNode {
  return node.type === "binary" && node.op !== "and" && node.op !== "or";
}

function functionCallToFilter(
  node: Extract<WhereNode, { type: "call" }>,
  registry: PropertyRegistry,
): CbaseFilter {
  const name = node.name.toLowerCase();

  if (
    ["contains", "startswith", "starts_with", "endswith", "ends_with"].includes(
      name,
    )
  ) {
    if (node.args.length !== 2) {
      throw new QueryLanguageParseError(
        `${node.name}() requires exactly 2 arguments`,
      );
    }

    const fieldArg = node.args[0];
    const valueArg = node.args[1];

    if (fieldArg?.type !== "field") {
      throw new QueryLanguageParseError(
        `${node.name}() first argument must be a field`,
      );
    }
    if (valueArg?.type !== "literal") {
      throw new QueryLanguageParseError(
        `${node.name}() second argument must be a literal`,
      );
    }

    const property = registry.ensure(fieldArg.name);
    const op =
      name === "contains"
        ? "contains"
        : name === "startswith" || name === "starts_with"
          ? "starts_with"
          : "ends_with";

    return {
      property,
      op,
      value: valueArg.value,
    };
  }

  if (["isempty", "is_empty"].includes(name)) {
    if (node.args.length !== 1 || node.args[0]?.type !== "field") {
      throw new QueryLanguageParseError(
        `${node.name}() requires exactly one field argument`,
      );
    }

    return {
      property: registry.ensure(node.args[0].name),
      op: "is_empty",
    };
  }

  throw new QueryLanguageParseError(
    `Unsupported WHERE function '${node.name}()' in .cbase mode`,
  );
}

function buildComparisonFilter(
  field: string,
  op: "=" | "!=" | "<" | ">" | "<=" | ">=",
  value: unknown,
  registry: PropertyRegistry,
): CbaseFilter {
  const property = registry.ensure(field, inferTypeFromLiteral(value));

  if (value === null) {
    if (op === "=") return { property, op: "is_empty" };
    if (op === "!=") return { property, op: "is_not_empty" };
    throw new QueryLanguageParseError(
      `Operator ${op} is not valid with NULL in WHERE`,
    );
  }

  return {
    property,
    op,
    value,
  };
}

function reverseComparisonOp(
  op: "=" | "!=" | "<" | ">" | "<=" | ">=",
): "=" | "!=" | "<" | ">" | "<=" | ">=" {
  switch (op) {
    case "<":
      return ">";
    case ">":
      return "<";
    case "<=":
      return ">=";
    case ">=":
      return "<=";
    default:
      return op;
  }
}

function inferTypeFromLiteral(value: unknown): CbasePropertyType | undefined {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  return undefined;
}

class PropertyRegistry {
  readonly properties: Record<string, CbaseProperty> = {};
  private readonly byKey = new Map<string, string>();

  ensure(key: string, hintType?: CbasePropertyType): string {
    const normalizedKey = key.trim();
    const existing = this.byKey.get(normalizedKey);
    if (existing) {
      this.applyTypeHint(existing, hintType);
      return existing;
    }

    const base = sanitizeId(normalizedKey);
    let id = base;
    let suffix = 2;

    while (this.properties[id]) {
      id = `${base}_${suffix}`;
      suffix += 1;
    }

    this.byKey.set(normalizedKey, id);
    this.properties[id] = {
      key: normalizedKey,
      type: hintType ?? inferTypeFromKey(normalizedKey),
    };

    return id;
  }

  private applyTypeHint(id: string, hintType?: CbasePropertyType): void {
    if (!hintType) return;
    const prop = this.properties[id];
    if (!prop) return;
    if (prop.type === hintType) return;

    // Upgrade from generic text when a stronger type hint is discovered.
    if (prop.type === "text") {
      prop.type = hintType;
    }
  }
}

function inferTypeFromKey(key: string): CbasePropertyType {
  const lower = key.toLowerCase();
  if (lower === "tags" || lower.endsWith(".tags")) return "multi_select";
  if (lower === "file.mtime" || lower.endsWith(".date")) return "date";
  return "text";
}

function sanitizeId(key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `p_${slug || "field"}`;
}

function splitClauses(query: string): string[] {
  const clauses: string[] = [];
  let current = "";

  for (const rawLine of query.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) continue;

    if (CLAUSE_START.test(line)) {
      if (current) clauses.push(current.trim());
      current = line;
      continue;
    }

    if (!current) {
      throw new QueryLanguageParseError(
        `Unexpected text before first clause: '${line}'`,
      );
    }

    current += ` ${line}`;
  }

  if (current) clauses.push(current.trim());
  return clauses;
}

function splitTopLevel(text: string, separator: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (ch === "\\") {
      i += 1;
      continue;
    }

    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle || inDouble) continue;

    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0 && ch === separator) {
      result.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }

  result.push(text.slice(start).trim());
  return result.filter(Boolean);
}

function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (ch === "\\") {
      i += 1;
      continue;
    }

    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && ch === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }

  return line;
}

function stripQueryFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:[A-Za-z0-9_-]+)?\s*\n([\s\S]*?)\n```$/);
  if (fenced) {
    return fenced[1] ?? "";
  }
  return raw;
}

function readQuoted(text: string, start: number): [string, number] {
  const quote = text[start];
  if (!quote) {
    throw new QueryLanguageParseError("Expected quoted string");
  }

  let i = start + 1;
  let value = "";

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "\\") {
      const next = text[i + 1];
      if (next == null) {
        throw new QueryLanguageParseError(
          "Unterminated escape sequence in string",
        );
      }
      value += next;
      i += 2;
      continue;
    }

    if (ch === quote) {
      return [value, i + 1];
    }

    value += ch;
    i += 1;
  }

  throw new QueryLanguageParseError("Unterminated string literal");
}

function unquote(text: string): string {
  if (text.length >= 2) {
    const head = text[0];
    const tail = text[text.length - 1];
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}
