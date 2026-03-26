<p align="center">
  <h1 align="center"><b>Chro</b></h1>
  <p align="center">
    Feed your knowledge, create in parallel.
    <br />
    An AI-powered, local-first desktop workspace for orchestrating Claude Code agents.
    <br />
    <br />
    <a href="https://chro-ai.com"><strong>Website</strong></a> ·
    <a href="#features"><strong>Features</strong></a> ·
    <a href="#how-it-works"><strong>How It Works</strong></a> ·
    <a href="#download"><strong>Download</strong></a> ·
    <a href="#architecture"><strong>Architecture</strong></a> ·
    <a href="#development"><strong>Development</strong></a> ·
    <a href="./SECURITY.md"><strong>Security</strong></a>
  </p>
</p>

Chro helps you turn your notes, research, and project context into parallel AI execution.
Launch multiple agents, each in its own isolated Git worktree, stream live logs and diffs, and
merge only what you approve. Powered by your existing Claude Code subscription.

## Features

- **Local-first knowledge base** — your ideas, notes, and research stay as files you own.
- **Parallel agent orchestration** — launch multiple agents from a single task screen, each in its own worktree sandbox.
- **Worktree isolation** — every agent runs in a dedicated Git worktree, keeping your main branch untouched until you're ready.
- **Unified knowledge editor** — review commits, logs, and assets in one place with inline diffs.
- **Real-time timelines** — stream live logs, events, and diffs as agents work.
- **Approval gates** — explicit approval required before agents apply sensitive commands or file operations.
- **Kanban task board** — organize work with focus and peek modes.
- **Built-in editor & Git workflow** — full diff and PR workflow without leaving the app.

## How It Works

1. **Feed the knowledge** — ideas, notes, and research live as local files. This context shapes how agents think, research, and create.
2. **Run safely in worktrees** — each agent runs in its own Git worktree. They can research, write code, generate assets, and update files without touching your main branch.
3. **Create in parallel** — launch multiple agents from a single task screen. Each gets its own worktree sandbox and timeline.
4. **Curate in one editor** — flip through every agent's commits, logs, and assets in the unified editor. Diff changes inline and merge only the pieces you approve.

## Download

Chro is available for macOS and Windows. Free during beta.

| Platform | Link |
|----------|------|
| macOS (Apple Silicon) | [Download .dmg](https://github.com/n-asuy/chro-ai/releases/latest) |
| macOS (Intel) | [Download .dmg](https://github.com/n-asuy/chro-ai/releases/latest) |
| Windows | [Download .exe](https://github.com/n-asuy/chro-ai/releases/latest) |

> Chro works with your existing **Claude Code** or **Codex** subscription. Sign in with your account and use your existing subscription.

## Safety & Privacy

- **Local-first by design** — workspaces live on your machine.
- **No training on your data** — content is not used to train AI models unless you explicitly consent.
- **Isolated execution** — agents run in worktrees with explicit approvals before applying risky changes.
- **You control merges** — nothing reaches your main workspace without your approval.
- **Security reporting** — if you believe you've found a vulnerability, follow [SECURITY.md](./SECURITY.md) and contact us privately.
- **Not affiliated with Anthropic** — Chro is an independent product that uses Claude Code via your subscription.

## Architecture

Chro is a monorepo with an Electron desktop shell, a React SPA frontend, and a Rust backend server.

```
┌─────────────────────────────────────────────────┐
│  Electron Shell (main process)                  │
│  Window management, auth, system tray, IPC      │
└────────────────────┬────────────────────────────┘
                     │ IPC
┌────────────────────▼────────────────────────────┐
│  React SPA (renderer process)                   │
│  TanStack Router · React Query · Zustand · Vite │
│                                                 │
│  Routes: /projects/:id/tasks, /files, /session  │
│  UI: Kanban board, file explorer, session view  │
└────────────────────┬────────────────────────────┘
                     │ HTTP / WebSocket
┌────────────────────▼────────────────────────────┐
│  Rust Backend Server (Axum)                     │
│  Task management, agent execution, git ops,     │
│  file system, real-time streaming               │
│                                                 │
│  SQLite for persistence · Tokio async runtime   │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  Local Workspace (Git Repository)               │
│  Worktrees for sandboxed agent execution        │
└─────────────────────────────────────────────────┘
```

### Repository Structure

```
chro/
├── apps/
│   ├── desktop/          # Electron + React desktop app
│   ├── api/              # Backend API server
├── crates/               # Rust backend libraries
│   ├── server/           # Axum HTTP/WebSocket server
│   ├── db/               # SQLite database layer (SQLx)
│   ├── runtime/          # Agent execution runtime
│   ├── local-runtime/    # Local execution adapter
│   ├── executors/        # Agent executor implementations
│   ├── worktree/         # Git worktree management
│   ├── git/              # Git operations
│   ├── filesystem/       # File I/O operations
│   ├── events/           # Event system
│   ├── approvals/        # Approval gate logic
│   ├── diff-stream/      # Real-time diff streaming
│   ├── file-search-cache/# File search indexing
│   ├── image/            # Image processing
│   ├── config/           # Configuration management
│   └── log-types/        # Log type definitions
├── packages/
│   ├── ui/               # Shared UI components
│   └── kv/               # Key-value store utilities
├── tooling/
│   ├── scripts/          # Build & deployment scripts
│   └── typescript/       # Shared TS config
└── docs/                 # Architecture and design documents
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 38 |
| Frontend | React 19, TanStack Router, Vite 7, Tailwind CSS 3, Zustand |
| Editors | CodeMirror 6, Monaco Editor |
| Backend | Rust, Axum 0.7, Tokio, SQLx (SQLite) |
| Build | Bun, Turbo, Biome |
| Packaging | electron-builder (macOS dmg, Windows nsis/zip, Linux AppImage) |

## Development

### Prerequisites

| Tool | Purpose |
|------|---------|
| [Bun](https://bun.sh) ≥ 1.1 | Package manager and JS runtime |
| [Rust](https://rustup.rs) | Backend server compilation |
| [Git](https://git-scm.com) | Version control and worktree support |
| Claude Code subscription | Agent execution |

### Install

```bash
bun install
```

### Run the Desktop App

```bash
# Full desktop app (Rust server + Vite + Electron)
bun dev:desktop

# Or run from within apps/desktop/
cd apps/desktop
bun dev
```

This concurrently starts:
1. The Rust backend server on port `4310`
2. Vite dev server on port `3400`
3. Electron shell connecting to the Vite dev server

### Web-only Development

```bash
cd apps/desktop
bun dev:web
```

Runs the Rust server and Vite without Electron, accessible at `http://localhost:3400`.

### Build & Package

```bash
cd apps/desktop
bun run build              # Vite build + Electron TypeScript compilation
bun run package            # Package with electron-builder
bun run package:release    # Build and publish release
```

### Tests & Lint

```bash
bun test                   # Run all tests
bun lint                   # Lint with Biome
bun typecheck              # TypeScript type checking
bun format                 # Format with Biome
```

## Pricing

| Plan | Price | Features |
|------|-------|----------|
| **Free** | $0 forever | Full source code access, self-hosted, community support |
| **Pro** | $20/month | Unlimited macOS & Windows apps, built-in editor & git, full diff & PR workflow |
| **Max** | $200/month | Everything in Pro + private resources, personal support, priority feature requests |

Free during beta. Works with your Claude Code / Codex subscription.

## FAQ

**What is Chro?**
A local-first app that orchestrates AI agents from your ideas, notes, and research. Each agent runs in its own Git worktree, keeping your main workspace safe while creating in parallel.

**How is Chro different from Claude Code CLI?**
Chro provides a native desktop UI with built-in editor, git management, and the ability to run multiple agents in parallel worktrees. It's designed to feel like a calm, integrated workspace rather than a command-line interface.

**How is Chro different from Claude Desktop?**
Claude Desktop is a general-purpose chat interface. Chro is purpose-built for knowledge work and development, with features like parallel agents, worktree isolation, built-in editor, and git workflows designed for shipping code.

**Is my data sent to external servers?**
Chro is local-first. Your knowledge, notes, and code stay on your machine. Only the prompts you send go through Anthropic's API using your own subscription.

## License

See [LICENSE](LICENSE) for details.
