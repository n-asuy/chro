/**
 * Glob pattern matching for .cbase dataset definitions
 */

import type { LensDataset } from "./types";

/** Match a relative path against a glob pattern (simplified) */
export function matchGlob(pattern: string, path: string): boolean {
  // Build regex by scanning the pattern character by character
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        // **/ matches zero or more directory levels
        regex += "(?:.+/)?";
        i += 3;
      } else {
        // ** at end matches everything
        regex += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      regex += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else if (".+^${}()|[]\\".includes(ch)) {
      regex += `\\${ch}`;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  return new RegExp(`^${regex}$`).test(path);
}

/** Check if a file path matches the dataset include/exclude patterns */
export function matchesDataset(
  relativePath: string,
  dataset: LensDataset,
): boolean {
  const included = dataset.include.some((pattern) =>
    matchGlob(pattern, relativePath),
  );
  if (!included) return false;

  if (dataset.exclude) {
    const excluded = dataset.exclude.some((pattern) =>
      matchGlob(pattern, relativePath),
    );
    if (excluded) return false;
  }

  return true;
}
