<p align="center">
  <img src="../../banner.jpg" alt="Chro — 让你的想法并行推进" width="100%">
</p>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../apps/desktop/assets/logo/logo_chro_invert_symbol.png">
  <source media="(prefers-color-scheme: light)" srcset="../../apps/desktop/assets/logo/logo_chro_symbol.png">
  <img alt="Chro" src="../../apps/desktop/assets/logo/logo_chro_symbol.png" width="50">
</picture>

# Chro

**让你的想法并行推进。**

以本地优先为核心的 AI 工作空间，用来协同多个编码代理。<br/>
在隔离的 worktree 中并行启动代理，实时查看 diff，只合并你明确批准的改动。

[![Check](https://github.com/n-asuy/chro/actions/workflows/check.yml/badge.svg)](https://github.com/n-asuy/chro/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/License-see_LICENSE.md-blue.svg)](../../LICENSE.md)

[官网](https://chro-ai.com) · [下载](https://github.com/n-asuy/chro/releases/latest) · [安全](../../SECURITY.md)

**[English](../../README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [Tiếng Việt](README.vi.md) | [Deutsch](README.de.md)**

</div>

## 什么是 Chro？

Chro 会把你的笔记、研究资料和项目上下文转化为并行的 AI 执行能力。你可以在一个任务界面中同时启动多个编码代理，每个代理都运行在独立的 Git worktree 中，在你准备好之前不会触碰主分支。

无需在终端之间来回切换上下文，也不用手动维护 worktree。代理的日志和 diff 会实时流入统一编辑器；只要你不明确批准，任何改动都不会进入主分支。可直接搭配你现有的 **Claude Code** 或 **Codex** 订阅使用。

<p align="center">
  <img src="../assets/demo1.png" alt="Chro 工作空间 1" width="49%">
  <img src="../assets/demo2.png" alt="Chro 工作空间 2" width="49%">
</p>
<p align="center">
  <img src="../assets/demo3.png" alt="Chro 工作空间 3" width="49%">
  <img src="../assets/demo4.png" alt="Chro 工作空间 4" width="49%">
</p>

## 功能

- **并行代理调度** — 在一个任务界面中同时启动多个代理。每个代理都拥有独立的 worktree 沙箱和实时时间线。
- **Worktree 隔离** — 每个代理都在专属的 Git worktree 中运行，合并前主分支始终保持安全。
- **本地优先知识库** — 你的想法、笔记和研究以你自己的文件形式保存在本地，这些上下文会直接影响代理的思考与生成。
- **统一编辑器** — 在一个地方查看所有代理的提交、日志和资源，并支持内联 diff。
- **审批机制** — 代理执行敏感命令或文件操作前，必须经过你的明确批准。
- **看板任务板** — 通过专注模式和预览模式，把工作安排得一目了然。
- **内置 Git 流程** — 不离开应用，也能完成 diff 审查和 PR 流程。

## 开始使用

### 桌面应用

下载并安装即可使用。测试期间免费，并可直接搭配 Claude Code / Codex 订阅运行。

| 平台 | 链接 |
|------|------|
| macOS (Apple Silicon) | [下载 .dmg](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [下载 .dmg](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [下载 .exe](https://github.com/n-asuy/chro/releases/latest) |

### CLI（浏览器 + 本地服务器）

无需桌面应用，也能通过浏览器和本地服务器运行 Chro，同时还提供任务管理命令。

```bash
npx @chro-ai/cli                # 启动 Chro（浏览器 + 本地服务器）
```

```bash
npx @chro-ai/cli task list                              # 列出任务
npx @chro-ai/cli task create "为认证模块添加单元测试"      # 创建任务
npx @chro-ai/cli task run <id>                          # 用代理运行任务
npx @chro-ai/cli task logs <id>                         # 流式查看执行日志
npx @chro-ai/cli task merge <id>                        # 合并代理更改
```

运行 `npx @chro-ai/cli --help` 查看完整命令参考。

## 快速开始

### 1. 打开项目

启动 Chro，并把任意 Git 仓库作为工作空间打开。本地文件会直接成为代理理解任务时使用的上下文。

### 2. 创建任务

在看板中创建任务，描述你想完成的内容，比如新功能、Bug 修复或重构。需要的话，也可以附上说明或文件。

### 3. 启动代理

为任务分配一个或多个代理。每个代理在自己的 Git worktree 中立即开始工作。通过时间线实时查看进度。

### 4. 审查与合并

在统一编辑器中查看每个代理的提交和 diff。保留你想要的部分，丢弃其余内容，然后完成合并，整个过程都在 Chro 内完成。

## 架构

```
apps/
  desktop/   → Electron + Vite + React (main product)
  api/       → Cloudflare Workers (Rust → WASM, D1)
  cli/       → CLI for browser mode + task management (Rust)
packages/
  ui/        → Shared UI components (Radix UI, Tailwind CSS)
crates/      → Rust backend (17 crates)
  server/    → Axum web server (SQLite, JSON-RPC, WebSocket)
  db/        → SQLx + SQLite ORM
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
                         │  (Axum + SQLite) │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │  Git Worktrees   │
                         │  (agent sandboxes)│
                         └──────────────────┘
```

| 层 | 技术栈 |
|----|--------|
| 桌面 | Electron 38 |
| 前端 | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| 编辑器 | CodeMirror 6, Monaco Editor |
| 后端 (本地) | Rust, Axum 0.7, Tokio, SQLx (SQLite) |
| 后端 (云端) | Rust → WASM, Cloudflare Workers, D1 |
| 构建 | Bun, Turborepo, Biome |

## 开发

**前置条件：** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # 安装依赖
bun dev:desktop      # 启动完整桌面应用（Rust + Vite + Electron）
```

```bash
bun test             # 运行测试
bun lint             # Biome 代码检查
bun typecheck        # TypeScript 类型检查
```

## 安全与隐私

Chro 从设计上就坚持本地优先。你的知识、笔记和代码都保存在自己的设备上。代理运行在隔离的 worktree 中，只有在你明确同意后，改动才会进入主分支。Chro 与 Anthropic 无关。漏洞报告方式请参阅 [SECURITY.md](../../SECURITY.md)。

## 许可证

详见 [LICENSE](../../LICENSE.md)。
