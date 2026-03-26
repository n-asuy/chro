import { create } from "zustand";

interface FilesCommandPaletteState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useFilesCommandPaletteStore = create<FilesCommandPaletteState>()(
  (set) => ({
    isOpen: false,
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
  }),
);
