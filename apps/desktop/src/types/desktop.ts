export type DesktopWorkspaceEntry = {
  type: "file" | "directory";
  name: string;
  displayName: string;
  relativePath: string;
  extension: string | null;
  hasChildren?: boolean;
  size?: number | null;
  modifiedAt?: string | null;
  createdAt?: string | null;
  children?: DesktopWorkspaceEntry[];
};

export type DesktopWorkspaceFile = {
  relativePath: string;
  content: string;
  size?: number | null;
  modifiedAt?: string | null;
};
