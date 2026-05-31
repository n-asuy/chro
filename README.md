<p align="center">
  <img src="banner.jpg" alt="Chro — Feed your knowledge, create in parallel" width="100%">
</p>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/desktop/assets/logo/logo_chro_invert_symbol.png">
  <source media="(prefers-color-scheme: light)" srcset="apps/desktop/assets/logo/logo_chro_symbol.png">
  <img alt="Chro" src="apps/desktop/assets/logo/logo_chro_symbol.png" width="50">
</picture>

# Chro

**Your ideas run in parallel.**

Local-first AI workspace for orchestrating coding agents.<br/>
Launch parallel agents in isolated worktrees, stream live diffs, merge only what you approve.

[![Check](https://github.com/n-asuy/chro/actions/workflows/check.yml/badge.svg)](https://github.com/n-asuy/chro/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/License-see_LICENSE.md-blue.svg)](LICENSE.md)

[Website](https://chro-ai.com) · [Download](https://github.com/n-asuy/chro/releases/latest) · [Security](SECURITY.md)

**English | [日本語](.github/i18n/README.ja.md) | [简体中文](.github/i18n/README.zh-CN.md) | [한국어](.github/i18n/README.ko.md) | [Español](.github/i18n/README.es.md) | [Français](.github/i18n/README.fr.md) | [Português](.github/i18n/README.pt-BR.md) | [Tiếng Việt](.github/i18n/README.vi.md) | [Deutsch](.github/i18n/README.de.md)**

</div>

## What is Chro?

Chro turns your notes, research, and project context into parallel AI execution. Launch multiple coding agents from a single task screen — each runs in its own Git worktree, keeping your main branch untouched until you're ready.

No context switching between terminals. No manual worktree juggling. Your agents stream live logs and diffs in a unified editor, and nothing reaches your main branch without your explicit approval. Works with your existing **Claude Code** or **Codex** subscription.

<p align="center">
  <img src="assets/demo1.png" alt="Chro task board" width="49%">
  <img src="assets/demo2.png" alt="Chro file editor" width="49%">
</p>
<p align="center">
  <img src="assets/demo3.png" alt="Chro session editor" width="49%">
  <img src="assets/demo4.png" alt="Chro agent execution" width="49%">
</p>

## Features

- **Parallel Agent Orchestration** — launch multiple agents from a single task screen. Each gets its own worktree sandbox and real-time timeline.
- **Worktree Isolation** — every agent runs in a dedicated Git worktree, keeping your main branch safe until you merge.
- **Local-First Knowledge** — your ideas, notes, and research stay as files you own. This context shapes how agents think and create.
- **Unified Editor** — review every agent's commits, logs, and assets in one place with inline diffs.
- **Approval Gates** — explicit approval required before agents apply sensitive commands or file operations.
- **Built-in Git Workflow** — full diff and PR workflow without leaving the app.

## Getting Started

### Desktop App

Download and install — free during beta. Works with your Claude Code / Codex subscription.

| Platform | Link |
|----------|------|
| macOS (Apple Silicon) | [Download .dmg](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [Download .dmg](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [Download .exe](https://github.com/n-asuy/chro/releases/latest) |

### CLI (Browser + Local Server)

Run Chro in your browser without the desktop app. Also provides task management commands.

```bash
npx @chro-ai/cli                # Start Chro (browser + local server)
```

```bash
npx @chro-ai/cli task list                              # List tasks
npx @chro-ai/cli task create "Add unit tests for auth"  # Create a task
npx @chro-ai/cli task run <id>                          # Run an agent on a task
npx @chro-ai/cli task logs <id>                         # Stream execution logs
npx @chro-ai/cli task merge <id>                        # Merge agent changes
```

See `npx @chro-ai/cli --help` for the full command reference.

## Quickstart

### 1. Open a project

Launch Chro and open any Git repository as a workspace. Your local files become the knowledge context for agents.

### 2. Create a task

Start a new session and describe what you want — a feature, a bug fix, a refactor. Attach notes or files for additional context.

### 3. Launch agents

Assign one or more agents to the task. Each agent spins up in its own Git worktree and starts working immediately. Watch progress in real time via the timeline.

### 4. Review and merge

Flip through each agent's commits and diffs in the unified editor. Approve the pieces you want, discard the rest, and merge — all without leaving Chro.

## Architecture

```
apps/
  desktop/   → Electron + Vite + React + Markdown-first workspace UI
  api/       → Cloudflare Workers (Rust → WASM, D1)
  cli/       → CLI for browser mode + task management (Rust)
packages/
  ui/        → Shared UI components (Radix UI, Tailwind CSS)
crates/      → Rust backend (17 crates)
  server/    → Axum web server (JSON-RPC, WebSocket, worktrees, local DB)
  db/        → SQLx + SQLite persistence layer
  ...        → worktree, git, executors, events, etc.
tooling/     → Build scripts, TS config, licenses
```

```
┌──────────────────┐
│  Electron Shell  │──────────┐
│  (main process)  │   IPC    │
└──────────────────┘          │
                         ┌────▼─────────────┐
┌──────────────────┐     │                  │
│  CLI / Browser   │────>│    React SPA     │
│  (npx @chro-ai)  │     │                  │
└──────────────────┘     └────────┬─────────┘
                                  │ JSON-RPC / WebSocket
                         ┌────────▼─────────┐
                         │  Rust Backend    │
                         │   (Axum RPC)     │
                         └───────┬────┬─────┘
                                 │    │
                  ┌──────────────▼────────┐  ┌▼───────────────┐
                  │    Git Worktrees      │  │  SQLite / D1   │
                  │   (agent sandboxes)   │  │ tasks, state,  │
                  └───────────────────────┘  │  metadata      │
                                             └────────────────┘
```

| Layer | Stack |
|-------|-------|
| Desktop | Electron 38 |
| Frontend | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| Content | Markdown-first files, frontmatter, CodeMirror 6 WYSIWYG, Monaco Editor |
| Data | SQLite + SQLx locally, D1 in cloud |
| Backend | Rust, Axum 0.7, Tokio, JSON-RPC, WebSocket |
| Build | Bun, Turborepo, Biome |

## Development

**Prerequisites:** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # Install dependencies
bun dev:desktop      # Start full desktop app (Rust + Vite + Electron)
bun dev:cli          # Start CLI flow (browser UI + local server)
```

```bash
bun test             # Run tests
bun lint             # Lint with Biome
bun typecheck        # TypeScript type checking
```

## Safety & Privacy

Chro is local-first by design. Your knowledge, notes, and code stay on your machine. Agents run in isolated worktrees with explicit approvals, and nothing reaches your main branch without your consent. Not affiliated with Anthropic. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

See [LICENSE](LICENSE.md) for details.
