type IssuePriority = "urgent" | "high" | "medium" | "low";

export interface IssueLabel {
  id: string;
  name: string;
  color: string;
}

export interface IssueState {
  id: string;
  name: string;
  color: string;
  group: "backlog" | "unstarted" | "started" | "completed";
}

export interface IssueMember {
  id: string;
  name: string;
  initials: string;
  title: string;
  accent: string;
}

interface IssueSubtask {
  id: string;
  title: string;
  done: boolean;
}

interface IssueReaction {
  emoji: string;
  count: number;
}

type IssueActivityType = "status" | "comment" | "note";

interface IssueActivityItem {
  id: string;
  label: string;
  type: IssueActivityType;
  timestamp: string;
  by: IssueMember;
}

interface IssueComment {
  id: string;
  author: IssueMember;
  message: string;
  timestamp: string;
}

export interface BoardIssue {
  id: string;
  sequenceId: number;
  key: string;
  title: string;
  summary: string;
  description: string;
  branch: string | null;
  activeSessionId?: string | null;
  priority: IssuePriority;
  state: IssueState;
  labels: IssueLabel[];
  startDate?: string;
  dueDate?: string;
  assignees: IssueMember[];
  attachments: number;
  links: number;
  subIssues: number;
  watchers: number;
  votes: number;
  reactions: IssueReaction[];
  subtasks: IssueSubtask[];
  activity: IssueActivityItem[];
  comments: IssueComment[];
  projectIdentifier: string;
  projectName: string;
  updatedAt: string;
  createdAt: string;
}

export interface BoardColumn {
  id: string;
  title: string;
  accent: string;
  issues: BoardIssue[];
}

export interface WorkspaceMeta {
  name: string;
  slug: string;
  projectId: string;
  projectName: string;
  projectIdentifier: string;
}

export interface BoardFilters {
  state: string[];
  priority: IssuePriority[];
  labels: string[];
}

export type BoardFilterKey = "state" | "priority" | "labels";
