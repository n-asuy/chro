import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeTextFile,
  isTextFileUnsaved,
  openTextFile,
  resetTextFilesForTest,
  textFileKey,
} from "./text-file-documents";

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("text file documents", () => {
  afterEach(() => {
    resetTextFilesForTest();
  });

  it("keys documents by project, worktree scope and path", () => {
    expect(textFileKey({ projectId: "p", path: "/a.md" })).not.toBe(
      textFileKey({ projectId: "p", taskRunId: "r", path: "/a.md" }),
    );
    expect(textFileKey({ projectId: "p", path: "/a.md" })).not.toBe(
      textFileKey({ projectId: "q", path: "/a.md" }),
    );
  });

  it("writes pending edits when the last view closes", async () => {
    const write = vi.fn(() => Promise.resolve());
    const key = textFileKey({ projectId: "p", path: "/a.md" });
    const model = openTextFile(key, write);
    model.applyDisk("a");
    model.setViewData("ab");

    closeTextFile(key);
    await flushMicrotasks();

    expect(write).toHaveBeenCalledWith("ab");
    expect(isTextFileUnsaved(key)).toBe(false);
  });

  it("hands a reopened view the same document while its save is in flight", async () => {
    let finishWrite: () => void = () => {};
    const write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const key = textFileKey({ projectId: "p", taskRunId: "r", path: "/a.md" });
    const first = openTextFile(key, write);
    first.applyDisk("a");
    first.setViewData("ab");
    closeTextFile(key);

    const reopened = openTextFile(key, write);
    expect(reopened).toBe(first);
    expect(reopened.data).toBe("ab");

    finishWrite();
    await reopened.settled();
    expect(isTextFileUnsaved(key)).toBe(false);
  });

  it("keeps a document whose save failed so its text survives reopening", async () => {
    const write = vi.fn(() => Promise.reject(new Error("read-only")));
    const key = textFileKey({ projectId: "p", path: "/a.md" });
    const model = openTextFile(key, write);
    model.applyDisk("a");
    model.setViewData("ab");

    closeTextFile(key);
    await flushMicrotasks();

    expect(isTextFileUnsaved(key)).toBe(true);
    expect(openTextFile(key, write).data).toBe("ab");
  });

  it("forgets a cleanly saved document after its last view closes", async () => {
    const write = vi.fn(() => Promise.resolve());
    const key = textFileKey({ projectId: "p", path: "/a.md" });
    const model = openTextFile(key, write);
    model.applyDisk("a");

    closeTextFile(key);
    await flushMicrotasks();

    expect(openTextFile(key, write)).not.toBe(model);
  });
});
