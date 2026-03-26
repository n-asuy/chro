import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";

const LEGACY_DIR_NAME = "Chronist";
const CURRENT_DIR_NAME = "Chro";
const LEGACY_RUNTIME_SUBDIR = "chronist";
const CURRENT_RUNTIME_SUBDIR = "chro";

/**
 * Migrate the Electron userData directory from legacy "Chronist" to "Chro".
 * Must be called BEFORE configureSharedUserData().
 */
export function migrateLegacyUserData(app: App): void {
  const appDataDir = app.getPath("appData");
  migrateDirectory(
    path.join(appDataDir, LEGACY_DIR_NAME),
    path.join(appDataDir, CURRENT_DIR_NAME),
  );

  // Within the renamed (or existing) directory, handle the runtime subdirectory
  const currentDir = path.join(appDataDir, CURRENT_DIR_NAME);
  if (fs.existsSync(currentDir)) {
    migrateDirectory(
      path.join(currentDir, LEGACY_RUNTIME_SUBDIR),
      path.join(currentDir, CURRENT_RUNTIME_SUBDIR),
    );
  }
}

function migrateDirectory(oldDir: string, newDir: string): void {
  if (!fs.existsSync(oldDir)) {
    return;
  }
  if (!fs.existsSync(newDir)) {
    try {
      fs.renameSync(oldDir, newDir);
      console.log(`[migration] Renamed ${oldDir} -> ${newDir}`);
    } catch (error) {
      console.error(`[migration] Failed to rename ${oldDir}:`, error);
    }
    return;
  }
  // Both exist: merge files from old that are missing in new
  try {
    for (const entry of fs.readdirSync(oldDir, { withFileTypes: true })) {
      const target = path.join(newDir, entry.name);
      if (fs.existsSync(target)) continue;
      const source = path.join(oldDir, entry.name);
      if (entry.isFile()) {
        fs.copyFileSync(source, target);
      } else if (entry.isDirectory()) {
        fs.renameSync(source, target);
      }
    }
    console.log(`[migration] Merged legacy files from ${oldDir}`);
  } catch (error) {
    console.error(`[migration] Failed to merge ${oldDir}:`, error);
  }
}
