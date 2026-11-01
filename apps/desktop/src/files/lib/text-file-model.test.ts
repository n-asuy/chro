import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TextFileModel } from "./text-file-model";

type Deferred = {
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * A write stub that records every call and lets the test decide when (and
 * whether) each write settles.
 */
const createWriter = () => {
  const calls: string[] = [];
  const pending: Deferred[] = [];
  let autoResolve = true;
  const write = vi.fn((content: string) => {
    calls.push(content);
    if (autoResolve) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  });
  return {
    write,
    calls,
    pending,
    holdWrites: () => {
      autoResolve = false;
    },
  };
};

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("TextFileModel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adopts the first disk read as the saved baseline", () => {
    const { write } = createWriter();
    const model = new TextFileModel({ write });

    expect(model.applyDisk("hello")).toEqual({
      data: "hello",
      merged: false,
    });
    expect(model.data).toBe("hello");
    expect(model.unsaved).toBe(false);
  });

  it("keeps an edit made before the disk baseline arrived", async () => {
    const writer = createWriter();
    const model = new TextFileModel({ write: writer.write });

    model.setViewData("edited");
    expect(model.loaded).toBe(false);
    expect(model.applyDisk("original")).toEqual({
      data: "edited",
      merged: false,
    });

    expect(model.loaded).toBe(true);
    expect(model.unsaved).toBe(true);
    vi.advanceTimersByTime(2000);
    await flushMicrotasks();
    expect(writer.calls).toEqual(["edited"]);
  });

  it("saves two seconds after the first unsaved edit, not after the last", async () => {
    const writer = createWriter();
    const model = new TextFileModel({ write: writer.write });
    model.applyDisk("a");

    model.setViewData("ab");
    expect(model.unsaved).toBe(true);
    vi.advanceTimersByTime(1500);
    model.setViewData("abc");
    vi.advanceTimersByTime(499);
    expect(writer.calls).toEqual([]);

    vi.advanceTimersByTime(1);
    await flushMicrotasks();

    // Continuous typing does not postpone the save indefinitely.
    expect(writer.calls).toEqual(["abc"]);
    expect(model.unsaved).toBe(false);
  });

  it("writes only when the content differs from what was last saved", async () => {
    const writer = createWriter();
    const model = new TextFileModel({ write: writer.write });
    model.applyDisk("a");

    model.setViewData("ab");
    model.setViewData("a");
    vi.advanceTimersByTime(2000);
    await flushMicrotasks();

    expect(writer.calls).toEqual([]);
    expect(model.unsaved).toBe(false);
  });

  it("saves immediately on an explicit save and cancels the pending timer", async () => {
    const writer = createWriter();
    const model = new TextFileModel({ write: writer.write });
    model.applyDisk("a");

    model.setViewData("ab");
    await model.save();
    vi.advanceTimersByTime(2000);
    await flushMicrotasks();

    expect(writer.calls).toEqual(["ab"]);
  });

  it("queues one more save when the user edits while a write is in flight", async () => {
    const writer = createWriter();
    writer.holdWrites();
    const model = new TextFileModel({ write: writer.write });
    model.applyDisk("a");

    model.setViewData("ab");
    const first = model.save();
    expect(model.saving).toBe(true);

    model.setViewData("abc");
    void model.save();
    expect(writer.calls).toEqual(["ab"]);

    writer.pending[0]?.resolve();
    await first;
    await flushMicrotasks();

    expect(writer.calls).toEqual(["ab", "abc"]);
    writer.pending[1]?.resolve();
    await flushMicrotasks();
    expect(model.unsaved).toBe(false);
  });

  it("keeps the edit unsaved and reports the error when the write fails", async () => {
    const writer = createWriter();
    writer.holdWrites();
    const onSaveError = vi.fn();
    const model = new TextFileModel({ write: writer.write, onSaveError });
    model.applyDisk("a");

    model.setViewData("ab");
    const saving = model.save();
    writer.pending[0]?.reject(new Error("disk full"));
    await saving;

    expect(onSaveError).toHaveBeenCalledWith(new Error("disk full"));
    expect(model.unsaved).toBe(true);
    expect(model.data).toBe("ab");

    // The next edit retries the write with the latest content.
    model.setViewData("abc");
    vi.advanceTimersByTime(2000);
    await flushMicrotasks();
    expect(writer.calls).toEqual(["ab", "abc"]);
  });

  it("replaces clean content with an external change", () => {
    const { write } = createWriter();
    const model = new TextFileModel({ write });
    model.applyDisk("one\n");

    expect(model.applyDisk("two\n")).toEqual({ data: "two\n", merged: false });
    expect(model.data).toBe("two\n");
    expect(model.unsaved).toBe(false);
  });

  it("ignores a disk read that matches what it last saved", async () => {
    const writer = createWriter();
    const model = new TextFileModel({ write: writer.write });
    model.applyDisk("a");
    model.setViewData("ab");
    await model.save();

    // The watcher echoes our own write back.
    expect(model.applyDisk("ab")).toBeNull();
    expect(model.data).toBe("ab");
  });

  it("merges an external change into unsaved edits", () => {
    const { write } = createWriter();
    const model = new TextFileModel({ write });
    model.applyDisk("alpha\nbeta\ngamma\n");

    model.setViewData("alpha\nbeta\ngamma\nmine\n");
    const result = model.applyDisk("theirs\nalpha\nbeta\ngamma\n");

    expect(result).toEqual({
      data: "theirs\nalpha\nbeta\ngamma\nmine\n",
      merged: true,
    });
    expect(model.data).toBe("theirs\nalpha\nbeta\ngamma\nmine\n");
    // The merged text still has to be written back.
    expect(model.unsaved).toBe(true);
  });

  it("treats an external change identical to the unsaved edit as saved", () => {
    const { write } = createWriter();
    const model = new TextFileModel({ write });
    model.applyDisk("a");

    model.setViewData("ab");
    expect(model.applyDisk("ab")).toBeNull();
    expect(model.unsaved).toBe(false);
  });

  it("ignores external changes while its own write is in flight", () => {
    const writer = createWriter();
    writer.holdWrites();
    const model = new TextFileModel({ write: writer.write });
    model.applyDisk("a");

    model.setViewData("ab");
    void model.save();

    expect(model.applyDisk("zzz")).toBeNull();
    expect(model.data).toBe("ab");
  });

  it("flushes the pending save when settled", async () => {
    const writer = createWriter();
    const model = new TextFileModel({ write: writer.write });
    model.applyDisk("a");
    model.setViewData("ab");

    await model.settled();

    expect(writer.calls).toEqual(["ab"]);
    expect(model.unsaved).toBe(false);
  });

  it("notifies subscribers when the unsaved state changes", async () => {
    const writer = createWriter();
    const model = new TextFileModel({ write: writer.write });
    model.applyDisk("a");
    const listener = vi.fn();
    model.subscribe(listener);

    model.setViewData("ab");
    expect(listener).toHaveBeenCalled();
    listener.mockClear();

    await model.save();
    expect(listener).toHaveBeenCalled();
    expect(model.unsaved).toBe(false);
  });
});
