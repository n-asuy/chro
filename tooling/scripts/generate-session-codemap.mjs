#!/usr/bin/env node

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const sessionDir = path.resolve(repoRoot, "apps/desktop/src/session");
const outputPath = path.resolve(sessionDir, "SESSION_CODEMAP.md");

function listFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") {
        continue;
      }
      files.push(...listFiles(absolute));
      continue;
    }
    if (!absolute.endsWith(".ts") && !absolute.endsWith(".tsx")) {
      continue;
    }
    files.push(absolute);
  }
  return files;
}

function uniq(values) {
  return [...new Set(values)];
}

function parseExportedSymbols(source) {
  const symbols = [];

  const declarationPattern =
    /export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z0-9_]+)/g;
  let match = declarationPattern.exec(source);
  while (match) {
    symbols.push(match[1]);
    match = declarationPattern.exec(source);
  }

  const namedExportPattern = /export\s*{\s*([^}]+)\s*}(?:\s*from\s*["'][^"']+["'])?/g;
  match = namedExportPattern.exec(source);
  while (match) {
    const inner = match[1] ?? "";
    const tokens = inner
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const asParts = part.split(/\s+as\s+/i).map((v) => v.trim());
        return asParts[1] ?? asParts[0];
      });
    symbols.push(...tokens);
    match = namedExportPattern.exec(source);
  }

  return uniq(symbols).sort((a, b) => a.localeCompare(b));
}

function parseRpcEndpoints(source) {
  const matches = source.match(/["'`]\/rpc\/[^"'`\s)]+["'`]/g) ?? [];
  const endpoints = matches.map((raw) => raw.slice(1, -1));
  return uniq(endpoints).sort((a, b) => a.localeCompare(b));
}

function formatList(values) {
  if (values.length === 0) return "-";
  if (values.length <= 4) return values.join(", ");
  return `${values.slice(0, 4).join(", ")}, ... (+${values.length - 4})`;
}

const files = listFiles(sessionDir)
  .map((absolute) => {
    const relative = path.relative(repoRoot, absolute).replaceAll("\\", "/");
    const source = readFileSync(absolute, "utf8");
    const stats = statSync(absolute);
    return {
      relative,
      symbols: parseExportedSymbols(source),
      rpcEndpoints: parseRpcEndpoints(source),
      mtime: stats.mtime.toISOString(),
    };
  })
  .sort((a, b) => a.relative.localeCompare(b.relative));

const totalSymbols = files.reduce((acc, f) => acc + f.symbols.length, 0);
const totalRpcRefs = files.reduce((acc, f) => acc + f.rpcEndpoints.length, 0);
const generatedAt = new Date().toISOString();

const lines = [
  "# Session Code Map",
  "",
  `Generated at: ${generatedAt}`,
  "",
  "## Summary",
  "",
  `- Files: ${files.length}`,
  `- Exported symbols: ${totalSymbols}`,
  `- RPC references: ${totalRpcRefs}`,
  "",
  "## File Index",
  "",
  "| File | Exports | RPC refs |",
  "| --- | --- | --- |",
];

for (const file of files) {
  lines.push(
    `| \`${file.relative}\` | ${formatList(file.symbols)} | ${formatList(file.rpcEndpoints)} |`,
  );
}

lines.push("", "## Notes", "");
lines.push("- This map is generated from static source analysis.");
lines.push("- It is intended for both human review and AI context priming.");
lines.push("- Regenerate with `bun run codemap:session`.");
lines.push("");

writeFileSync(outputPath, lines.join("\n"));
console.log(`Wrote ${path.relative(repoRoot, outputPath)} (${files.length} files)`);
