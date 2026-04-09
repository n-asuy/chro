<p align="center">
  <img src="../../banner.jpg" alt="Chro — Suas ideias avançam em paralelo" width="100%">
</p>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../apps/desktop/assets/logo/logo_chro_invert_symbol.png">
  <source media="(prefers-color-scheme: light)" srcset="../../apps/desktop/assets/logo/logo_chro_symbol.png">
  <img alt="Chro" src="../../apps/desktop/assets/logo/logo_chro_symbol.png" width="50">
</picture>

# Chro

**Suas ideias avançam em paralelo.**

Ambiente de trabalho de IA local-first para coordenar agentes de código.<br/>
Lance agentes em paralelo em worktrees isolados, acompanhe diffs em tempo real e faça merge só do que você aprovar.

[![Check](https://github.com/n-asuy/chro/actions/workflows/check.yml/badge.svg)](https://github.com/n-asuy/chro/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/License-see_LICENSE.md-blue.svg)](../../LICENSE.md)

[Website](https://chro-ai.com) · [Download](https://github.com/n-asuy/chro/releases/latest) · [Segurança](../../SECURITY.md)

**[English](../../README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | Português | [Tiếng Việt](README.vi.md) | [Deutsch](README.de.md)**

</div>

## O que é o Chro?

O Chro transforma suas notas, pesquisas e o contexto do projeto em execução paralela de IA. A partir de uma única tela de tarefas, você pode lançar vários agentes de código, cada um em seu próprio worktree Git, sem tocar na branch principal até a hora de decidir.

Sem ficar alternando contexto entre terminais. Sem gerenciar worktrees na mão. Os agentes transmitem logs e diffs em tempo real em um editor unificado, e nada chega à branch principal sem sua aprovação explícita. Funciona com sua assinatura atual do **Claude Code** ou **Codex**.

<p align="center">
  <img src="../assets/demo1.png" alt="Workspace do Chro 1" width="49%">
  <img src="../assets/demo2.png" alt="Workspace do Chro 2" width="49%">
</p>
<p align="center">
  <img src="../assets/demo3.png" alt="Workspace do Chro 3" width="49%">
  <img src="../assets/demo4.png" alt="Workspace do Chro 4" width="49%">
</p>

## Funcionalidades

- **Orquestração paralela de agentes** — lance vários agentes a partir de uma única tela de tarefas. Cada um recebe seu próprio sandbox de worktree e uma linha do tempo em tempo real.
- **Isolamento por worktree** — cada agente roda em um worktree Git dedicado, mantendo sua branch principal protegida até o merge.
- **Conhecimento local-first** — suas ideias, notas e pesquisas continuam sendo arquivos seus. Esse contexto influencia a forma como os agentes pensam e produzem.
- **Editor unificado** — revise commits, logs e arquivos gerados por todos os agentes em um só lugar, com diffs inline.
- **Aprovações obrigatórias** — os agentes precisam da sua aprovação explícita antes de executar comandos sensíveis ou operações em arquivos.
- **Quadro Kanban** — organize o trabalho visualmente com modos de foco e visão rápida.
- **Workflow Git integrado** — acompanhe diffs e PRs sem sair do app.

## Começando

### App Desktop

Baixe e instale. O app é grátis durante o beta e funciona com sua assinatura Claude Code / Codex.

| Plataforma | Link |
|------------|------|
| macOS (Apple Silicon) | [Baixar .dmg](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [Baixar .dmg](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [Baixar .exe](https://github.com/n-asuy/chro/releases/latest) |

### CLI (Navegador + Servidor local)

Execute o Chro no navegador sem o app desktop. Você também conta com comandos para gerenciar tarefas.

```bash
npx @chro-ai/cli                # Iniciar Chro (navegador + servidor local)
```

```bash
npx @chro-ai/cli task list                              # Listar tarefas
npx @chro-ai/cli task create "Adicionar testes de auth"  # Criar tarefa
npx @chro-ai/cli task run <id>                          # Executar agente na tarefa
npx @chro-ai/cli task logs <id>                         # Ver logs de execução
npx @chro-ai/cli task merge <id>                        # Fazer merge das alterações
```

Execute `npx @chro-ai/cli --help` para a referência completa de comandos.

## Início rápido

### 1. Abra um projeto

Inicie o Chro e abra qualquer repositório Git como workspace. Seus arquivos locais passam a ser o contexto que orienta o trabalho dos agentes.

### 2. Crie uma tarefa

Use o quadro Kanban para criar uma tarefa. Descreva o que você quer: uma funcionalidade, uma correção ou uma refatoração. Se precisar, anexe notas ou arquivos como contexto.

### 3. Lance agentes

Atribua um ou mais agentes à tarefa. Cada agente começa imediatamente em sua própria worktree Git. Acompanhe o progresso em tempo real pela timeline.

### 4. Revise e faça merge

Navegue pelos commits e diffs de cada agente no editor unificado. Aprove as partes desejadas, descarte o resto e faça o merge, tudo sem sair do Chro.

## Arquitetura

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

| Camada | Stack |
|--------|-------|
| Desktop | Electron 38 |
| Frontend | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| Editor | CodeMirror 6, Monaco Editor |
| Backend (local) | Rust, Axum 0.7, Tokio, SQLx (SQLite) |
| Backend (nuvem) | Rust → WASM, Cloudflare Workers, D1 |
| Build | Bun, Turborepo, Biome |

## Desenvolvimento

**Pré-requisitos:** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # Instalar dependências
bun dev:desktop      # Iniciar app desktop completo (Rust + Vite + Electron)
```

```bash
bun test             # Executar testes
bun lint             # Lint com Biome
bun typecheck        # Verificação de tipos TypeScript
```

## Segurança e privacidade

O Chro foi projetado com uma abordagem local-first. Seu conhecimento, suas notas e seu código permanecem na sua máquina. Os agentes rodam em worktrees isolados, e nada chega à sua branch principal sem seu consentimento explícito. O Chro não é afiliado à Anthropic. Consulte [SECURITY.md](../../SECURITY.md) para relatar vulnerabilidades.

## Licença

Veja [LICENSE](../../LICENSE.md) para detalhes.
