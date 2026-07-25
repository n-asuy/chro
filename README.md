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

Chro is a workspace for running coding agents in parallel and deciding what their work is worth. You describe the outcome you want, agents execute in isolated Git worktrees, and their changes stream back as live diffs. Nothing reaches your branch until you approve it.

It works with the agent subscriptions you already have (**Claude Code**, **Codex**) and keeps everything on your machine: your notes, your repositories, your history.

## Design Principles

Chro is opinionated. These are the opinions.

### Agents edit, you decide

Chro is not an editor and does not compete with your IDE. In Chro the human work is directing agents, reviewing what they produce, and curating the knowledge they draw from. Editing files by hand is the exception, not the premise. Every design decision below follows from this inversion.

### The unit of work is the session, not the file

An IDE puts the file tree first because files are what you operate on. In Chro the primary object is the running session, so the screen reads left to right as *who → dialogue → evidence*:

- **Left: who is working.** Sessions and agents across all projects. This is the navigation you touch most, so it gets the primary position.
- **Center: the dialogue.** The conversation with the agent is the work itself, not a side channel.
- **Right: the evidence.** Files, search, and Git live in one inspection dock. You reach for them to verify what an agent did, not as the starting point of work.

### Sandboxes belong to agents, the canonical branch belongs to you

Every agent runs in a disposable worktree so your branch stays untouched while any number of agents work at once. That distinction is an execution detail, and it must not leak into your mental model:

- **You step into a sandbox to review**, primarily through diffs and commits. It is a read-mostly surface.
- **Anything you author yourself lands on the canonical side**: notes, documents, structured views (`.cbase`), diagrams. Writing a note should never require deciding which worktree it belongs to.

### Knowledge is files under version control

Your context is plain files in a Git repository: Markdown notes, frontmatter, structured views, diagrams. No proprietary silo, no export step. This is what makes the knowledge durable (it versions like code), portable (it clones like code), and useful (agents read it the same way you do).

### Nothing lands without consent

Agents propose, you dispose. Sensitive commands and file operations wait behind approval gates, diffs are visible while the agent is still running, and merging is always an explicit act. Parallelism is only safe because every result is quarantined until reviewed.

## Features

- **Parallel agent orchestration**: launch multiple agents from a single task. Each gets its own worktree sandbox and a real-time timeline.
- **Worktree isolation**: every agent runs in a dedicated Git worktree, keeping your branch safe until you merge.
- **Local-first knowledge**: your ideas, notes, and research stay as files you own, and shape how agents think.
- **Unified review**: every agent's commits, logs, and diffs in one place.
- **Approval gates**: explicit approval before agents run sensitive commands or file operations.
- **Built-in Git workflow**: full diff and PR workflow without leaving the app.

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

Start a new session and describe what you want: a feature, a bug fix, a refactor. Attach notes or files for additional context.

### 3. Launch agents

Assign one or more agents to the task. Each agent spins up in its own Git worktree and starts working immediately. Watch progress in real time via the timeline.

### 4. Review and merge

Flip through each agent's commits and diffs. Approve the pieces you want, discard the rest, and merge, all without leaving Chro.

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
