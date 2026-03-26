export * from "./normalized";
export * from "./execution-process";
export * from "./api";
export * from "./context";

/**
 * Stored task record from database
 */
export type StoredTask = {
  id: string;
  project_id: string;
  title: string;
  description?: string | null;
  status: string;
  branch?: string | null;
  active_session_id?: string | null;
  created_at: string;
  updated_at: string;
  sort_order: number;
};

/**
 * UI event message from realtime stream
 */
export type UiEventMessage = {
  type: "ui_event";
  payload?: {
    kind: string;
    data?: unknown;
  };
};
