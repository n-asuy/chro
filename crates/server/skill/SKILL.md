---
name: chro
description: Drive chro sessions with the `chro` CLI. Use when you run inside a chro session and want to hand work to another session, wait for or read another session, answer an approval a delegated session is stuck on, leave a status note on your session, or start, merge, or inspect sessions from a terminal. Prefer it over editing chro's database, worktrees, or HTTP API directly.
allowed-tools:
  - Bash(chro *)
---

# chro CLI

This file is an entry point, not the guide. The full guide is printed by the
`chro` binary itself, so it always matches the commands of the chro you are
running. Load it before your first `chro` command in a session:

```bash
chro skill show
```

Do not guess commands or flags from memory or from an older copy of this file;
they change between chro releases. Prefer `--json` for calls you parse, and
branch on `error.code`. If `chro` reports `runtime_not_running`, run the command
listed in `error.next`.
