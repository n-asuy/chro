<p align="center">
  <img src="../../banner.jpg" alt="Chro — 注入你的知识，并行创造" width="100%">
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

Chro 是一个工作空间，用来并行运行编码代理，并判断它们的工作有多大价值。你描述想要的结果，代理在隔离的 Git worktree 中执行，它们的改动以实时 diff 的形式流回。在你批准之前，任何内容都不会进入你的分支。

它可以直接搭配你现有的代理订阅（**Claude Code**、**Codex**）使用，并把一切都留在你的设备上：你的笔记、你的仓库、你的历史。

## 设计原则

Chro 是一款有主见的产品。以下就是这些主见。

### 代理来编辑，你来决策

Chro 不是编辑器，也不与你的 IDE 竞争。在 Chro 中，人的工作是指挥代理、审查它们的产出，并整理它们所依赖的知识。手动编辑文件是例外，而不是前提。下面的每一条设计决策都源于这一颠倒。

### 工作的单位是会话，而不是文件

IDE 把文件树放在第一位，因为文件是你直接操作的对象。而在 Chro 中，首要对象是正在运行的会话，所以界面从左到右依次呈现 *谁 → 对话 → 证据*：

- **左侧：谁在工作。** 跨所有项目的会话和代理。这是你使用最频繁的导航，因此占据首要位置。
- **中间：对话。** 与代理的对话本身就是工作，而不是一条附属通道。
- **右侧：证据。** 文件、搜索和 Git 集中在一个检视面板中。你打开它们是为了核实代理做了什么，而不是把它们当作工作的起点。

### 沙箱属于代理，规范分支属于你

每个代理都运行在一个可随时丢弃的 worktree 中，因此无论多少个代理同时工作，你的分支都不会被触碰。这一区分只是执行层面的细节，绝不应渗入你的心智模型：

- **你进入沙箱是为了审查**，主要通过 diff 和提交进行。它是一个以读为主的界面。
- **凡是你亲手创作的内容都落在规范一侧**：笔记、文档、结构化视图（`.cbase`）、图表。写一条笔记永远不应该需要你先决定它属于哪个 worktree。

### 知识是纳入版本控制的文件

你的上下文就是 Git 仓库里的纯文件：Markdown 笔记、frontmatter、结构化视图、图表。没有专有的数据孤岛，也没有导出步骤。正因如此，这些知识才耐久（像代码一样有版本）、可迁移（像代码一样可克隆）、真正有用（代理和你以同样的方式读取它）。

### 未经同意，什么都不会落地

代理提议，你来定夺。敏感命令和文件操作必须在审批关卡前等待，代理还在运行时 diff 就已可见，合并永远是一个明确的动作。并行之所以安全，正是因为每个结果在通过审查之前都处于隔离状态。

## 功能

- **并行代理调度**：从一个任务同时启动多个代理。每个代理都拥有独立的 worktree 沙箱和实时时间线。
- **Worktree 隔离**：每个代理都在专属的 Git worktree 中运行，合并之前你的分支始终保持安全。
- **本地优先知识库**：你的想法、笔记和研究以你自己拥有的文件形式保存，并塑造代理的思考方式。
- **统一审查**：在一个地方查看每个代理的提交、日志和 diff。
- **审批机制**：代理执行敏感命令或文件操作前，必须经过你的明确批准。
- **内置 Git 流程**：不离开应用，也能完成完整的 diff 和 PR 流程。

## 开始使用

### 桌面应用

下载并安装即可使用。测试期间免费，可直接搭配你的 Claude Code / Codex 订阅运行。

| 平台 | 链接 |
|------|------|
| macOS (Apple Silicon) | [下载 .dmg](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [下载 .dmg](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [下载 .exe](https://github.com/n-asuy/chro/releases/latest) |

### CLI（浏览器 + 本地服务器）

无需桌面应用，也能在浏览器中运行 Chro，同时还提供任务管理命令。

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

启动 Chro，并把任意 Git 仓库作为工作空间打开。本地文件会成为代理可用的知识上下文。

### 2. 创建任务

开启一个新会话，描述你想完成的内容：新功能、Bug 修复或重构。可以附上笔记或文件作为额外上下文。

### 3. 启动代理

为任务分配一个或多个代理。每个代理会在自己的 Git worktree 中启动并立即开始工作。通过时间线实时查看进度。

### 4. 审查与合并

逐一查看每个代理的提交和 diff。批准你想要的部分，丢弃其余内容，然后完成合并，整个过程都不需要离开 Chro。

## 架构

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

| 层 | 技术栈 |
|----|--------|
| 桌面 | Electron 38 |
| 前端 | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| 内容 | Markdown 优先的文件, frontmatter, CodeMirror 6 WYSIWYG, Monaco Editor |
| 数据 | 本地 SQLite + SQLx，云端 D1 |
| 后端 | Rust, Axum 0.7, Tokio, JSON-RPC, WebSocket |
| 构建 | Bun, Turborepo, Biome |

## 开发

**前置条件：** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # 安装依赖
bun dev:desktop      # 启动完整桌面应用（Rust + Vite + Electron）
bun dev:cli          # 启动 CLI 流程（浏览器 UI + 本地服务器）
```

```bash
bun test             # 运行测试
bun lint             # Biome 代码检查
bun typecheck        # TypeScript 类型检查
```

## 安全与隐私

Chro 从设计上就坚持本地优先。你的知识、笔记和代码都保存在自己的设备上。代理运行在隔离的 worktree 中并受明确审批约束，未经你的同意，任何改动都不会进入主分支。Chro 与 Anthropic 无关。漏洞报告方式请参阅 [SECURITY.md](../../SECURITY.md)。

## 许可证

详见 [LICENSE](../../LICENSE.md)。
