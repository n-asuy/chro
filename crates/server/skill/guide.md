# chro CLI

`chro` drives the chro app that is running on this machine. Inside a chro session it acts as that session: `self` is you, `parent` is the session that delegated you, and everything you do is attributed to you.

## Rules

- Read results as JSON. Output is one JSON envelope when stdout is not a terminal (`--json` forces it): `{"ok": true, "result": ...}` or `{"ok": false, "error": {"code": ..., "message": ..., "next": [...]}}`.
- Branch on `error.code`, never on message text. `error.next` lists complete commands to run next.
- If a command reports `runtime_not_running`, run `chro open` and retry. If it reports `unreachable` after a command that changes something, run the command in `error.next`: it repeats the request with the same request id, so it cannot act twice.
- `chro schema` lists every command, flag, selector, error code and exit code. Use it instead of guessing a flag.

## Selectors

- Session: `self`, `parent`, a slug (`ab12cd34`), a unique slug prefix of 3+ characters, or a full id.
- Project: a slug, a full id, or `path:<absolute dir>`. Commands that need a project default to the repository of the current directory.

## Hand work to another session

Delegate a piece of your work. The new session starts at once with a digest of yours. When every session you delegated has finished, you are woken with their results in one message, so do not poll.

```bash
chro session delegate --prompt "Write integration tests for the login redirect in crates/server"
```

Long briefs read from stdin with `--prompt -`:

```bash
chro session delegate --prompt - < brief.md
```

If a delegated session stops on an approval, you are woken with the approval id. Inspect it and answer it, or leave it for the user when it is outside what you were asked to oversee. You cannot answer approvals of your own session.

```bash
chro approval show <approval>
chro approval respond <approval> --approve
chro approval respond <approval> --deny --reason "use the existing helper instead"
chro approval respond <approval> --answer "Which database?=sqlite"
```

## Watch another session

```bash
chro session show <session>
chro session wait <session> --for idle --timeout 30m
chro session wait <session> --for settled
chro session read <session>
chro session read <session> --since <cursor>
chro session read <session> --format markdown
```

`wait --for idle` returns when no turn is running and nothing is queued; `--for input` when the session is stuck on an approval or question; `--for settled` on whichever comes first. A timeout exits with code 6 and `error.code` `timeout`.

`read` returns entries with cursors; pass the last `next_cursor` as `--since` to get only what is new.

## Talk to a session

```bash
chro session send <session> --prompt "Also cover the logout path"
```

A message to an idle session starts a turn. A message to a busy session waits in its queue and runs when the current turn ends; add `--no-queue` to fail with `session_busy` instead.

`chro session show <session>` lists the queue with each message's id. Take one back before it runs with `unqueue`, which accepts the id or a unique prefix of 3+ characters:

```bash
chro session unqueue <session> <message>
```

## Leave a status line

Update your note at checkpoints: after a repro, a fix, a test run, a handoff, or when blocked. People see it on your session's row.

```bash
chro session set self --note "fix implemented; running integration tests"
```

## Start and land sessions from a terminal

```bash
chro session new --prompt "Add JWT validation to crates/server"
chro session new --prompt "Profile the build" --agent codex --effort high
chro session list --state running
chro session diff <session>
chro session merge <session> -m "feat: add JWT auth"
chro session rebase <session> --onto main
chro session cancel <session>
chro project list
chro skill install
```
