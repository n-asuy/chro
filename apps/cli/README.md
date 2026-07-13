# Chro CLI

Run Chro in your browser without the desktop app, and manage tasks from the terminal.

The CLI downloads a platform-specific Rust binary (`chro-server`) from R2, starts it locally, and opens the web UI. Task subcommands talk to a running server over HTTP.

## Install

```bash
npx @chro-ai/cli          # Run directly (downloads binary on first run)
```

Requires Node.js 18+.

## Quick Start

```bash
# 1. Start Chro (launches local server + opens browser UI)
npx @chro-ai/cli

# 2. Create a task and run an agent
npx @chro-ai/cli task create "Add auth middleware" --prompt "Implement JWT auth"

# 3. Watch progress
npx @chro-ai/cli task logs <task-id>

# 4. Merge when satisfied
npx @chro-ai/cli task merge <task-id>
```

## Commands

### `chro`

Start the local server and web UI. Equivalent to `chro dev`.

### `chro dev [--perf]`

Launch development services (Rust server + Vite). Pass `--perf` to enable performance recording to `log/performance/`.

All `chro task` subcommands take a **task** identifier (UUID or slug). A task may have multiple runs (initial execution + follow-ups); operations target the latest run by default. Use `--run N` (1-indexed, chronological) to target a specific run.

### `chro task list`

List tasks for the current project (detected from CWD's git root).

### `chro task create <title>`

Create a new task and optionally start an agent run.

| Flag | Description |
|------|-------------|
| `-d, --description` | Task description |
| `--prompt` | Prompt for the agent |
| `--no-run` | Create task only, skip agent execution |

### `chro task status <task> [STATUS]`

Show the task's run history, or update task status to one of: `pending`, `in_progress`, `blocked`, `completed`, `failed`, `cancelled`.

### `chro task run <task> [-p, --prompt]`

Start a new agent execution on an existing task.

### `chro task logs <task>`

Print the markdown transcript for the task (all runs combined, chronological order). Agents fetch this when a `<past_session>` tag references the task.

### `chro task cancel <task> [-r, --run N]`

Stop a running execution.

### `chro task diff <task> [-r, --run N]`

Show branch and commit range for a run.

### `chro task merge <task> [-m, --message] [-r, --run N]`

Merge run changes into the target branch.

### `chro task rebase <task> [-o, --onto <branch>] [-r, --run N]`

Rebase the run's branch onto a new base.

### Global Options

| Flag | Description |
|------|-------------|
| `-w, --project <path>` | Git repository path (default: CWD's git root) |
| `--help` | Show help |
| `-v, --version` | Show version |

## How It Works

```
npx @chro-ai/cli
       │
       ▼
  cli.js (Node)
       │  downloads + caches chro-server binary from R2
       │  verifies SHA-256 checksum
       ▼
  chro-server (Rust)
       │  Axum web server on port 4310
       │  SQLite database
       │  manages Git worktrees for agent sandboxes
       ▼
  Browser UI (React SPA served by Vite or embedded)
```

Task commands connect to a running server by reading the port from `$TMPDIR/chro/chro.port`.

## Development

For contributors working on the CLI itself within the Chro repository.

### Run from source

```bash
cd apps/cli
cargo run                  # Start server + Vite (dev mode)
cargo run -- task list     # Run task subcommands
cargo run -- --perf        # Enable perf recording
```

The binary locates the repo root at runtime. Set `CHRO_REPO_ROOT` explicitly when running from outside the checkout.

### Test

```bash
cargo test --manifest-path apps/cli/Cargo.toml
```

### Local build

```bash
cd apps/cli
bash ./local-build.sh
```

Builds the Rust binary, zips it into `npx-cli/dist/<platform>/chro-server.zip`, syncs the npm package version from `crates/server/Cargo.toml`, and produces an npm tarball.

### Release

```bash
cd apps/cli
R2_ENDPOINT=... R2_BUCKET=... R2_PUBLIC_URL=... bash ./release.sh
```

Uploads `chro-server.zip` to R2, stores the resolved public URL in npm metadata, and publishes with `npm publish`. Optional env vars: `R2_PREFIX`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CHRO_REPO_ROOT` | Override repo root detection |
| `CHRO_SERVER_READY_TIMEOUT_SECS` | Server startup timeout (default: 120) |
| `CHRO_LOCAL` | Set to `1` to use locally built binaries in `npx-cli/dist/` |
| `CHRO_DEBUG` | Enable debug output in the npm wrapper |
