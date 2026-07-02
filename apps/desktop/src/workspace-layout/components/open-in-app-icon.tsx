import { cn } from "@/lib/cn";
import type { OpenInIconId } from "../lib/open-in";

export type { OpenInIconId };

const iconUrls = {
  cmux: new URL("./open-in-app-icons/cmux.png", import.meta.url).href,
  cursor: new URL("./open-in-app-icons/cursor.svg", import.meta.url).href,
  "file-explorer": new URL(
    "./open-in-app-icons/file-explorer.svg",
    import.meta.url,
  ).href,
  finder: new URL("./open-in-app-icons/finder.png", import.meta.url).href,
  ghostty: new URL("./open-in-app-icons/ghostty.svg", import.meta.url).href,
  iterm2: new URL("./open-in-app-icons/iterm2.svg", import.meta.url).href,
  obsidian: new URL("./open-in-app-icons/obsidian.svg", import.meta.url).href,
  powershell: new URL("./open-in-app-icons/powershell.svg", import.meta.url)
    .href,
  terminal: new URL("./open-in-app-icons/terminal.svg", import.meta.url).href,
  vscode: new URL("./open-in-app-icons/vscode.svg", import.meta.url).href,
  zed: new URL("./open-in-app-icons/zed.svg", import.meta.url).href,
} satisfies Record<OpenInIconId, string>;

type OpenInAppIconProps = {
  id: OpenInIconId;
  className?: string;
};

export function OpenInAppIcon({ id, className }: OpenInAppIconProps) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("block h-4 w-4 object-contain", className)}
      draggable={false}
      src={iconUrls[id]}
    />
  );
}
