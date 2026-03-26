
import { forwardRef } from "react";

export const KanbanIssueBlockLoader = forwardRef<HTMLSpanElement>((_, ref) => (
  <span
    ref={ref}
    className="m-1.5 block h-28 rounded bg-custom-background-80 animate-pulse"
  />
));

KanbanIssueBlockLoader.displayName = "KanbanIssueBlockLoader";
