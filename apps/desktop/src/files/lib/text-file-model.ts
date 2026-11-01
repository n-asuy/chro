import { diff_match_patch } from "diff-match-patch";

/** Delay between the first unsaved edit and the automatic save. */
export const TEXT_FILE_SAVE_DELAY_MS = 2000;

export type TextFileModelOptions = {
  /** Persist the full document text. Rejects when the write fails. */
  write: (content: string) => Promise<void>;
  saveDelayMs?: number;
  onSaveError?: (error: Error) => void;
};

/** What the editor should display after a disk read, or null for no change. */
export type DiskApplyResult = { data: string; merged: boolean } | null;

/**
 * Three-way merge: replay the local edit (base → mine) onto the external
 * version. Patch application is fuzzy, so hunks still land after the external
 * change shifted the surrounding text.
 */
export const mergeTextChanges = (
  base: string,
  mine: string,
  theirs: string,
): string => {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(base, mine, true);
  if (diffs.length > 2) {
    dmp.diff_cleanupSemantic(diffs);
    dmp.diff_cleanupEfficiency(diffs);
  }
  const patches = dmp.patch_make(base, diffs);
  return dmp.patch_apply(patches, theirs)[0];
};

/**
 * Save state of one open text document, independent of any view.
 *
 * Semantics:
 * - The first unsaved edit schedules a save `saveDelayMs` later. Further edits
 *   do not push the timer back, so continuous typing still saves regularly.
 * - Only one write is in flight; an edit during a write queues exactly one
 *   follow-up save with the latest text.
 * - A failed write leaves the text unsaved and reports the error.
 * - A disk read replaces clean content, merges into unsaved content, and is
 *   ignored while our own write is in flight.
 *
 * "Unsaved" means the text differs from what was last written or read, so it
 * stays true after a failed write and an external change never overwrites it.
 */
export class TextFileModel {
  /** Null until the view or the disk provides text. */
  private viewData: string | null = null;
  private lastSavedData: string | null = null;
  private isSaving = false;
  private saveAgain = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly write: (content: string) => Promise<void>;
  private readonly saveDelayMs: number;
  private readonly onSaveError?: (error: Error) => void;

  constructor({
    write,
    saveDelayMs = TEXT_FILE_SAVE_DELAY_MS,
    onSaveError,
  }: TextFileModelOptions) {
    this.write = write;
    this.saveDelayMs = saveDelayMs;
    this.onSaveError = onSaveError;
  }

  get data(): string {
    return this.viewData ?? this.lastSavedData ?? "";
  }

  /** Whether the disk baseline has been read. */
  get loaded(): boolean {
    return this.lastSavedData !== null;
  }

  get unsaved(): boolean {
    return (
      this.lastSavedData !== null &&
      this.viewData !== null &&
      this.viewData !== this.lastSavedData
    );
  }

  get saving(): boolean {
    return this.isSaving;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Record a user edit and schedule the automatic save. */
  setViewData(text: string): void {
    if (text === this.viewData) return;
    this.viewData = text;
    this.scheduleSave();
    this.emit();
  }

  /** Reconcile the document with freshly read disk content. */
  applyDisk(disk: string): DiskApplyResult {
    if (this.lastSavedData === null) {
      // The view may already hold edits made on top of its own read.
      this.lastSavedData = disk;
      this.viewData ??= disk;
      if (this.unsaved) this.scheduleSave();
      this.emit();
      return { data: this.viewData, merged: false };
    }
    if (this.isSaving) return null;

    const base = this.lastSavedData;
    this.lastSavedData = disk;
    if (base === disk) return null;

    const mine = this.viewData ?? base;
    if (mine === disk) {
      this.emit();
      return null;
    }
    if (mine !== base) {
      this.viewData = mergeTextChanges(base, mine, disk);
      this.emit();
      return { data: this.viewData, merged: true };
    }
    this.viewData = disk;
    this.emit();
    return { data: disk, merged: false };
  }

  /** Write the current text now. Resolves once this save attempt finishes. */
  async save(): Promise<void> {
    this.cancelTimer();
    if (this.isSaving) {
      this.saveAgain = true;
      return this.inFlight ?? undefined;
    }
    const data = this.viewData;
    if (
      data === null ||
      this.lastSavedData === null ||
      data === this.lastSavedData
    ) {
      return;
    }

    const previous = this.lastSavedData;
    this.lastSavedData = data;
    this.isSaving = true;
    this.emit();

    const attempt = (async () => {
      try {
        await this.write(data);
      } catch (err) {
        // Restore the baseline so the text reads as unsaved again, unless a
        // disk read already moved it.
        if (this.lastSavedData === data) this.lastSavedData = previous;
        this.onSaveError?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        this.isSaving = false;
        this.inFlight = null;
        this.emit();
      }
    })();
    this.inFlight = attempt;
    await attempt;

    if (this.saveAgain) {
      // Starts synchronously, so `settled()` sees the follow-up as in flight.
      this.saveAgain = false;
      void this.save();
    }
  }

  /** Flush any pending save and wait until no write is in flight. */
  async settled(): Promise<void> {
    if (this.timer !== null) await this.save();
    while (this.inFlight) await this.inFlight;
  }

  /** True when nothing is scheduled or being written. */
  get idle(): boolean {
    return this.timer === null && !this.isSaving;
  }

  /** Schedule a save unless one is pending; later edits do not delay it. */
  private scheduleSave(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, this.saveDelayMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
