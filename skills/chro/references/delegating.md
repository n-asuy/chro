# Delegating work to other sessions

Use this when the user asks you to delegate, or when the work splits into
parts that can run at the same time. In a chro session "delegate" means a chro
session, not the harness's built-in subagent: a chro session has its own
worktree and branch, the user can watch and steer it, and chro wakes you when
it finishes.

Commands: guide section "Hand work to another session".

## Your role

Once you delegate, you coordinate: you split the work, write the briefs,
review what comes back, and integrate it. Do not also implement a part you
handed out. If the user named which agent should implement, pass that agent
when you delegate and keep design and review for yourself.

## Before you delegate

1. Commit what the other sessions need. A delegated session gets a new
   worktree cut from the committed state of your branch. Files you have not
   committed do not exist there.
2. Split so that no two sessions edit the same files. Shared files (an index,
   a lockfile, a migration sequence) belong to exactly one session, or to you
   at integration time.
3. Decide what "done" means for each part before you write its brief.

## The brief

A delegated session starts with a digest of your session and your brief. It
has not seen your reasoning and cannot ask you a question cheaply, so the
brief has to stand on its own. Write these parts, in this order, and nothing
else:

1. **Task**: one outcome, stated as the result you want.
2. **Done when**: checks the session can run itself (a test command, a page
   that renders, a file that exists).
3. **Scope**: the files or directories it owns, and what it must leave alone.
   Name the sessions working beside it and what they own.
4. **Limits**: every restriction the user put on you applies to the sessions
   you start, and they do not inherit it unless you write it down. State what
   is forbidden (for example pushing, deploying, sending messages, deleting
   resources, touching production) and say that anything outside the limits
   is reported back, not attempted.
5. **Report**: ask for the final message described in
   [delegated-session.md](delegated-session.md), and say that it must be
   written even when nothing was committed.

Keep it short. A brief that repeats general rules at length hides the task.
Long briefs go in through stdin.

## While they run

Do not poll. When every session you delegated has finished, chro wakes you
with one message that carries their results. Spend the time on work that does
not depend on them, or end your turn.

If you are woken because a delegated session is stuck on an approval, inspect
it and answer it when it falls inside what the user asked you to oversee.
Leave it for the user when it does not.

To change a running session's direction, send it a message instead of
starting a replacement (guide section "Talk to a session").

## When results arrive

For each result:

1. Read the report. If the result is empty, read the session's conversation
   (guide section "Watch another session") before deciding anything. Do not
   treat an empty result as a finished task.
2. Check the evidence yourself: look at the diff, run the check named under
   "Done when", open the screenshot. A report is a claim until you have.
3. If something is missing, send that session a message that names the gap
   precisely and what would close it. Do not redo the work in your own
   worktree.
4. Integrate one branch at a time and run the project's checks after each
   one. Parts that passed alone can still break together.

## Your own report

Tell the user what was delegated, what each session produced, what you
verified yourself, and what is still open. Name sessions by title; an id alone
tells the user nothing.
