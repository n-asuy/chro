# Chro CLI

Run Chro in your browser without the desktop app, and drive its sessions from the terminal.

The CLI downloads a platform-specific Rust binary (`chro-server`) from R2, starts it locally, and opens the web UI. The other commands drive a running server through its operator API.

## Install

```bash
npx @chro-ai/cli          # Run directly (downloads binary on first run)
```

Requires Node.js 18+.

## Quick Start

```bash
# 1. Start Chro (launches local server + opens browser UI)
npx @chro-ai/cli

# 2. Start a session in the current repository
npx @chro-ai/cli session new --prompt "Implement JWT auth"

# 3. Wait for it, then read what it did
npx @chro-ai/cli session wait <session> --for idle
npx @chro-ai/cli session read <session>

# 4. Merge when satisfied
npx @chro-ai/cli session merge <session>
```

## Commands

`chro-server` with no command starts the local server and web UI. Every other command talks to a running chro app or server. The desktop app ships the same commands as the `chro` binary and puts it on the PATH of every agent it starts.

| Command | What it does |
|---|---|
| `status` | Which server answers and who the caller is to it |
| `open` | Start the desktop app and wait until it accepts commands |
| `schema` | Every command, flag, selector, error code and exit code as JSON |
| `project list / show / add` | Repositories and folders sessions run in |
| `session list / show` | Sessions with their state (`idle`, `running`, `awaiting_input`), note, queue, parent and children |
| `session new --prompt` | Start a session and its first turn |
| `session delegate --prompt` | Hand work to a new session; the delegating session is woken with the results |
| `session send --prompt` | Start a turn, or queue the message behind the running one |
| `session wait --for idle\|input\|settled` | Block until the session reaches that state |
| `session read [--since <cursor>]` | The conversation as entries; `--format markdown` for the transcript |
| `session set --note / --title / --status` | Change a session; the note shows on its row |
| `session unqueue <session> <message>` | Take a queued message back before it runs (id or 3+ character prefix, as listed by `session show`) |
| `session fork / cancel / refs / diff / merge / rebase` | Branch, stop, inspect, and land a session |
| `approval list / show / respond` | Answer tool calls and questions a session waits on |
| `skill install / show` | Install the skill that teaches agents these commands |

Selectors: a session is `self`, `parent`, a slug, a unique slug prefix of 3+ characters, or an id; a project is a slug, an id, or `path:<absolute dir>`. Inside a chro session, `self` is that session.

Output is one JSON envelope (`{"ok", "result" | "error", "meta"}`) when stdout is not a terminal; `--json` and `--human` override. Exit codes: 0 success, 1 server failure, 2 usage, 3 not found, 4 state conflict, 5 server unreachable, 6 wait timed out, 7 unauthorized or contract mismatch.

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
       │  Axum web server
       │  SQLite database, runtime.json beside it
       │  manages Git worktrees for agent sandboxes
       ▼
  Browser UI (React SPA served by Vite or embedded)
```

A running server writes `runtime.json` next to its database: its URL, process id, and the owner token that opens the operator API (`/v1`). Commands find the server through that file, skipping files whose process is gone. Agents started by chro get `CHRO_RUNTIME_FILE` and a per-turn `CHRO_SESSION_TOKEN`, so they reach the server that started them and act as their own session.

## Development

For contributors working on the CLI itself within the Chro repository.

### Run from source

```bash
cargo run --manifest-path crates/server/Cargo.toml                         # Start the server
cargo run --manifest-path crates/server/Cargo.toml --bin chro -- status    # Run a command
```

### Test

```bash
cargo test --manifest-path crates/server/Cargo.toml
```

### Local build

```bash
cd apps/cli
bash ./local-build.sh
```

Builds the Rust binary, zips it into `npx-cli/dist/<platform>/chro-server.zip`, syncs the npm package version from `crates/server/Cargo.toml`, and produces an npm tarball.

### Release

Releases are cut by pushing a `v*` tag (`bun run release` from `apps/desktop`,
which bumps every version in the repo together). CI then builds `chro-server`
for all five targets, uploads them plus a checksum manifest to R2, and
publishes the npm wrapper.

There is deliberately no local publish path: it would bypass the release gate,
and its version bump would touch only some of the files the tag script keeps in
sync.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CHRO_API_URL` | Base URL of a server on another machine. Commands then skip local runtime files |
| `CHRO_API_TOKEN` | Owner token of that server, sent as a bearer token |
| `CHRO_OWNER_TOKEN` | Server side: use this owner token instead of generating one per start, for servers whose clients are configured out of band |
| `CHRO_RUNTIME_FILE` | Runtime file to use first; chro sets it for every agent it starts |
| `CHRO_USER_DATA_DIR` | Directory of the desktop app's data, and so of its runtime file |
| `CHRO_SERVER_READY_TIMEOUT_SECS` | Server startup timeout (default: 120) |
| `CHRO_LOCAL` | Set to `1` to use locally built binaries in `npx-cli/dist/` |
| `CHRO_DEBUG` | Enable debug output in the npm wrapper |

### Talking to a server on another machine

```bash
export CHRO_API_URL=https://your-host.example
export CHRO_API_TOKEN=…   # that server's owner token
chro session list --project path:/path/on/that/host
```

Commands then run against that server, and nothing is started locally. Name
projects by paths **on that machine**: the server resolves them, not your
working directory.

### Instances managed by a control plane

Built only with `--features cloud`, so it is absent from released binaries.
A control plane creates the machine and hands back its address; the ordinary
commands then target it without `CHRO_API_URL` being set by hand.

```bash
CHRO_CLOUD_TOKEN=… chro cloud login https://control-plane.example
chro cloud up            # create on first use, wake afterwards
chro session list        # runs against the instance
chro cloud down          # stop, keeping the disk
```

`chro cloud status` shows the instance, `chro cloud destroy` removes it.
Which control plane to use is entirely yours to choose — no address is built
into the binary.
