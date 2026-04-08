import { Plus } from "lucide-react";
import { useCallback, useState } from "react";

import {
  AddTaskPanel,
  type AddTaskPayload,
  type AddTaskSubmitOptions,
} from "@/kanban/components/add-task-panel";
import { useWorkspaceBoardContext } from "@/kanban/providers";

export const SidebarQuickActions = () => {
  const [isOpen, setIsOpen] = useState(false);
  const { columns, addIssueToColumn, projectId } = useWorkspaceBoardContext();
  const defaultColumn = columns[0];

  const defaultColumnId = defaultColumn?.id;
  const canAddTask = Boolean(defaultColumnId);

  const handleSubmit = useCallback(
    (payload: AddTaskPayload, options?: AddTaskSubmitOptions) => {
      if (!defaultColumnId) return;
      addIssueToColumn(defaultColumnId, payload.title, {
        summary: payload.summary,
        prompt: payload.prompt,
        runImmediately: options?.runImmediately,
        useWorktree: options?.useWorktree,
        executorProfileId: options?.executorProfileId,
        targetBranch: options?.targetBranch,
      });
    },
    [addIssueToColumn, defaultColumnId],
  );

  const handleOpen = () => {
    if (!canAddTask) return;
    setIsOpen(true);
  };

  const handleClose = () => setIsOpen(false);

  return (
    <div className="relative">
      <AddTaskPanel
        isOpen={isOpen && canAddTask}
        onClose={handleClose}
        onSubmit={handleSubmit}
        projectId={projectId}
      />
      <div className="flex items-center justify-between gap-2 cursor-pointer">
        <button
          type="button"
          className="flex-grow text-custom-text-300 text-sm font-medium border-[0.5px] border-custom-sidebar-border-300 text-left rounded-md shadow-sm h-8 px-2 flex items-center gap-1.5 bg-white hover:bg-custom-sidebar-background-100 disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-custom-primary-100 focus-visible:ring-offset-1 focus-visible:ring-offset-white"
          data-ph-element="sidebar_create_work_item_button"
          onClick={handleOpen}
          disabled={!canAddTask}
        >
          <Plus className="size-4" strokeWidth={2} />
          <span>Add Task</span>
        </button>
      </div>
    </div>
  );
};
