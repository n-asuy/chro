import { create } from "zustand";

/**
 * Open state for the session-search command palette (the wide two-pane modal
 * that searches across sessions and runs a few commands). Lifted out of the
 * projects panel so a global keyboard shortcut (⌘K / ⌘P) mounted at the shell
 * level can open the very same modal the panel's Search button opens.
 *
 * File search is a separate surface — the right-dock Search panel, driven by
 * {@link useRightDockStore.focusSearchPanel} and bound to ⌘⇧F.
 */
interface CommandPaletteStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  openPalette: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  openPalette: () => set({ open: true }),
}));
