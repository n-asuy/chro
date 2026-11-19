import { AgentLogo } from "@/components/agent-logo";
import {
  useOpenSessionFromDirectory,
  useSessionBySlug,
} from "@/session/context/session-directory-context";
import { sessionMentionLabel } from "@/session/lib/session-label";
import type { StoredTask } from "@/session/types";
import type { ReactNode } from "react";
import { useSessionPreviewTrigger } from "./session-preview-trigger";

/**
 * A slug the agent wrote, shown as the session it names: the title's opening
 * instead of the id, the session preview on hover, the session on click.
 * Renders `children` (the text as written) when the slug names no session.
 */
export function SessionMention({
  slug,
  children,
}: {
  slug: string;
  children: ReactNode;
}) {
  const task = useSessionBySlug(slug);
  if (!task) return <>{children}</>;
  return <ResolvedSessionMention task={task} slug={slug} />;
}

function ResolvedSessionMention({
  task,
  slug,
}: {
  task: StoredTask;
  slug: string;
}) {
  const openSession = useOpenSessionFromDirectory();
  const preview = useSessionPreviewTrigger(task, "below");

  const activate = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    preview.hoverProps.onPointerDown();
    openSession(task);
  };

  return (
    <span
      ref={preview.setAnchor}
      data-session-mention={task.id}
      role="link"
      tabIndex={0}
      aria-label={task.title || slug}
      // Inline, not inline-flex: a long label must wrap with the sentence
      // instead of jumping whole to the next line.
      className="cursor-pointer font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
      onPointerEnter={preview.hoverProps.onPointerEnter}
      onPointerLeave={preview.hoverProps.onPointerLeave}
      onPointerDown={preview.hoverProps.onPointerDown}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") activate(event);
      }}
    >
      <AgentLogo
        agent={task.last_executor}
        className="mr-1 inline-block h-3 w-3 align-[-1px]"
      />
      {sessionMentionLabel(task.title, slug)}
    </span>
  );
}
