---
name: chro
description: Drive chro sessions with the `chro` CLI. Use when you run inside a chro session and are asked to delegate work, split a job across several sessions, or discuss a question with another model (Codex, Gemini, another Claude); when another session delegated a task to you; when you want to wait for or read another session, answer an approval a delegated session is stuck on, split a long session by topic, leave a status note on your session, or start, merge, or inspect sessions from a terminal. Prefer it over the harness's built-in subagents when the user says "delegate", and over editing chro's database, worktrees, or HTTP API directly.
allowed-tools: Bash(chro *)
---

# chro CLI

## Commands

The command guide is printed by the `chro` binary itself, so it always matches
the commands of the chro you are running. Load it before your first `chro`
command in a session:

```bash
chro skill show
```

Do not guess commands or flags from memory or from an older copy of this
skill; they change between chro releases. Prefer `--json` for calls you parse,
and branch on `error.code`. If `chro` reports `runtime_not_running`, run the
command listed in `error.next`.

## Procedures

The guide says what each command does. These files say how to work with them.
Read the one that matches the situation, and only that one:

| Situation | Read |
|---|---|
| You are asked to delegate, or the work splits into parts that other sessions can do | [references/delegating.md](references/delegating.md) |
| Another session delegated this task to you | [references/delegated-session.md](references/delegated-session.md) |
| You are asked to discuss, debate, or cross-check something with other models | [references/model-debate.md](references/model-debate.md) |
| A session has drifted across several topics, or its title no longer fits | [references/session-split.md](references/session-split.md) |

The procedures name commands by the section of the guide that documents them,
never by their syntax, for the same reason: take the syntax from
`chro skill show`.
