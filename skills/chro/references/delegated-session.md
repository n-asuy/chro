# Working as a delegated session

Use this when another session delegated your task to you. You can tell from
the brief, and from `parent` resolving to a session.

The session that delegated you is not watching. It is woken once, when you
finish, with your last message as the result. Everything it learns about your
work comes from that message.

## Finish inside the turn

- Work until the brief's "done" condition holds. Do not end the turn to report
  progress, and do not end it on a sentence like "next I will check".
- If something takes time (a build, a test run, a remote job), wait for it in
  this turn. A turn that ends while a job is still running leaves nobody to
  read its result.
- Finish or abort anything you start that leaves the repository half-way,
  such as a rebase or a merge, before the turn ends.
- If a limit in the brief blocks you, stop and say so in the final message.
  Do not work around the limit.

## Leave a trail

Update your status note at checkpoints: after a repro, after a fix, after a
test run, when blocked (guide section "Leave a status line"). The note is how
the delegating session and the user see where you are without asking. It also
tells whoever resumes you after an interruption where you stopped.

Keep evidence the report points to (screenshots, logs, measurements) in files
that are committed with your work. Files that git ignores can disappear with
the worktree.

## The final message

Always end with a final message that has content, including when you changed
nothing or failed. Write it for a reader who has not seen your session:

1. **Result**: what is true now that was not before, in one or two sentences.
   If the task is not done, say that first.
2. **Changes**: files changed and the commit, or "no changes".
3. **Verification**: what you ran or looked at, and what it showed. Separate
   what you confirmed from what you infer.
4. **Evidence**: full paths to screenshots, logs, or reports.
5. **How to run it**: one line, when there is something to run.
6. **Open items**: for each, what happens if it is left, and what you
   recommend.

Reply in the language the brief was written in.
