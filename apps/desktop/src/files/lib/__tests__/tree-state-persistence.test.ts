import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadExpandedPaths,
  saveExpandedPaths,
  clearExpandedPaths,
} from "../tree-state-persistence";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(global, "window", {
  value: {
    localStorage: localStorageMock,
  },
  writable: true,
});

describe("tree-state-persistence", () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  describe("loadExpandedPaths", () => {
    it("should return empty set when no data exists", () => {
      const result = loadExpandedPaths("/test/workspace");
      expect(result).toEqual(new Set());
    });

    it("should load persisted expanded paths", () => {
      const workspacePath = "/test/workspace";
      const expandedPaths = new Set([
        "/folder1",
        "/folder2",
        "/folder1/subfolder",
      ]);

      saveExpandedPaths(workspacePath, expandedPaths);
      const loaded = loadExpandedPaths(workspacePath);

      expect(loaded).toEqual(expandedPaths);
    });

    it("should handle special characters in workspace path", () => {
      const workspacePath = "/test/workspace with spaces/special-chars";
      const expandedPaths = new Set(["/folder1"]);

      saveExpandedPaths(workspacePath, expandedPaths);
      const loaded = loadExpandedPaths(workspacePath);

      expect(loaded).toEqual(expandedPaths);
    });

    it("should return empty set for corrupted data", () => {
      const key = "files-tree-state-" + btoa("/test/workspace");
      localStorageMock.setItem(key, "invalid json");

      const result = loadExpandedPaths("/test/workspace");
      expect(result).toEqual(new Set());
    });

    it("should ignore data with wrong version", () => {
      const key = "files-tree-state-" + btoa("/test/workspace");
      const wrongVersion = {
        version: 999,
        expandedPaths: ["/folder1"],
        lastUpdated: Date.now(),
      };
      localStorageMock.setItem(key, JSON.stringify(wrongVersion));

      const result = loadExpandedPaths("/test/workspace");
      expect(result).toEqual(new Set());
    });
  });

  describe("saveExpandedPaths", () => {
    it("should save expanded paths to localStorage", () => {
      const workspacePath = "/test/workspace";
      const expandedPaths = new Set(["/folder1", "/folder2"]);

      saveExpandedPaths(workspacePath, expandedPaths);

      const key = "files-tree-state-" + btoa(workspacePath);
      const stored = localStorageMock.getItem(key);
      expect(stored).toBeTruthy();

      const parsed = JSON.parse(stored!);
      expect(parsed.version).toBe(1);
      expect(parsed.expandedPaths).toEqual(["/folder1", "/folder2"]);
      expect(parsed.lastUpdated).toBeTypeOf("number");
    });

    it("should overwrite existing data", () => {
      const workspacePath = "/test/workspace";
      const expandedPaths1 = new Set(["/folder1"]);
      const expandedPaths2 = new Set(["/folder2", "/folder3"]);

      saveExpandedPaths(workspacePath, expandedPaths1);
      saveExpandedPaths(workspacePath, expandedPaths2);

      const loaded = loadExpandedPaths(workspacePath);
      expect(loaded).toEqual(expandedPaths2);
    });

    it("should handle empty set", () => {
      const workspacePath = "/test/workspace";
      const expandedPaths = new Set<string>();

      saveExpandedPaths(workspacePath, expandedPaths);

      const loaded = loadExpandedPaths(workspacePath);
      expect(loaded).toEqual(new Set());
    });
  });

  describe("clearExpandedPaths", () => {
    it("should clear expanded paths for a workspace", () => {
      const workspacePath = "/test/workspace";
      const expandedPaths = new Set(["/folder1"]);

      saveExpandedPaths(workspacePath, expandedPaths);
      clearExpandedPaths(workspacePath);

      const loaded = loadExpandedPaths(workspacePath);
      expect(loaded).toEqual(new Set());
    });

    it("should not affect other workspaces", () => {
      const workspace1 = "/test/workspace1";
      const workspace2 = "/test/workspace2";
      const expandedPaths1 = new Set(["/folder1"]);
      const expandedPaths2 = new Set(["/folder2"]);

      saveExpandedPaths(workspace1, expandedPaths1);
      saveExpandedPaths(workspace2, expandedPaths2);

      clearExpandedPaths(workspace1);

      const loaded1 = loadExpandedPaths(workspace1);
      const loaded2 = loadExpandedPaths(workspace2);

      expect(loaded1).toEqual(new Set());
      expect(loaded2).toEqual(expandedPaths2);
    });
  });

  describe("workspace isolation", () => {
    it("should keep separate state for different workspaces", () => {
      const workspace1 = "/test/workspace1";
      const workspace2 = "/test/workspace2";
      const expandedPaths1 = new Set(["/folder1", "/folder2"]);
      const expandedPaths2 = new Set(["/folder3", "/folder4"]);

      saveExpandedPaths(workspace1, expandedPaths1);
      saveExpandedPaths(workspace2, expandedPaths2);

      const loaded1 = loadExpandedPaths(workspace1);
      const loaded2 = loadExpandedPaths(workspace2);

      expect(loaded1).toEqual(expandedPaths1);
      expect(loaded2).toEqual(expandedPaths2);
    });
  });
});
