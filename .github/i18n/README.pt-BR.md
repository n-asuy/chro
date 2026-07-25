<p align="center">
  <img src="../../banner.jpg" alt="Chro: alimente seu conhecimento, crie em paralelo" width="100%">
</p>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../apps/desktop/assets/logo/logo_chro_invert_symbol.png">
  <source media="(prefers-color-scheme: light)" srcset="../../apps/desktop/assets/logo/logo_chro_symbol.png">
  <img alt="Chro" src="../../apps/desktop/assets/logo/logo_chro_symbol.png" width="50">
</picture>

# Chro

**Suas ideias avançam em paralelo.**

Ambiente de trabalho de IA local-first para orquestrar agentes de código.<br/>
Lance agentes em paralelo em worktrees isolados, acompanhe diffs em tempo real e faça merge só do que você aprovar.

[![Check](https://github.com/n-asuy/chro/actions/workflows/check.yml/badge.svg)](https://github.com/n-asuy/chro/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/License-see_LICENSE.md-blue.svg)](../../LICENSE.md)

[Website](https://chro-ai.com) · [Download](https://github.com/n-asuy/chro/releases/latest) · [Segurança](../../SECURITY.md)

**[English](../../README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | Português | [Tiếng Việt](README.vi.md) | [Deutsch](README.de.md)**

</div>

## O que é o Chro?

O Chro é um workspace para executar agentes de código em paralelo e decidir quanto vale o trabalho deles. Você descreve o resultado que quer, os agentes executam em worktrees Git isolados e as alterações chegam de volta como diffs em tempo real. Nada alcança a sua branch até você aprovar.

Ele funciona com as assinaturas de agente que você já tem (**Claude Code**, **Codex**) e mantém tudo na sua máquina: suas notas, seus repositórios, seu histórico.

## Princípios de design

O Chro é opinativo. Estas são as opiniões.

### Os agentes editam, você decide

O Chro não é um editor e não compete com a sua IDE. No Chro, o trabalho humano é direcionar agentes, revisar o que eles produzem e curar o conhecimento do qual eles se alimentam. Editar arquivos à mão é a exceção, não a premissa. Toda decisão de design abaixo decorre dessa inversão.

### A unidade de trabalho é a sessão, não o arquivo

Uma IDE coloca a árvore de arquivos em primeiro lugar porque arquivos são aquilo que você manipula. No Chro, o objeto primário é a sessão em execução, então a tela se lê da esquerda para a direita como *quem → diálogo → evidência*:

- **Esquerda: quem está trabalhando.** Sessões e agentes de todos os projetos. É a navegação que você mais usa, por isso ocupa a posição principal.
- **Centro: o diálogo.** A conversa com o agente é o próprio trabalho, não um canal secundário.
- **Direita: a evidência.** Arquivos, busca e Git vivem em um único dock de inspeção. Você recorre a eles para verificar o que um agente fez, não como ponto de partida do trabalho.

### Os sandboxes pertencem aos agentes, a branch canônica pertence a você

Cada agente roda em um worktree descartável, de modo que a sua branch permanece intocada enquanto qualquer número de agentes trabalha ao mesmo tempo. Essa distinção é um detalhe de execução e não deve vazar para o seu modelo mental:

- **Você entra em um sandbox para revisar**, principalmente por meio de diffs e commits. É uma superfície voltada sobretudo à leitura.
- **Tudo o que você mesmo escreve fica no lado canônico**: notas, documentos, visões estruturadas (`.cbase`), diagramas. Escrever uma nota nunca deveria exigir decidir a qual worktree ela pertence.

### Conhecimento são arquivos sob controle de versão

Seu contexto são arquivos simples em um repositório Git: notas em Markdown, frontmatter, visões estruturadas, diagramas. Sem silo proprietário, sem etapa de exportação. É isso que torna o conhecimento durável (ele é versionado como código), portátil (ele é clonado como código) e útil (os agentes o leem da mesma forma que você).

### Nada entra sem consentimento

Os agentes propõem, você decide. Comandos sensíveis e operações em arquivos aguardam atrás de portões de aprovação, os diffs ficam visíveis enquanto o agente ainda está rodando e o merge é sempre um ato explícito. O paralelismo só é seguro porque todo resultado fica em quarentena até ser revisado.

## Funcionalidades

- **Orquestração paralela de agentes**: lance vários agentes a partir de uma única tarefa. Cada um recebe seu próprio sandbox de worktree e uma linha do tempo em tempo real.
- **Isolamento por worktree**: cada agente roda em um worktree Git dedicado, mantendo sua branch protegida até o merge.
- **Conhecimento local-first**: suas ideias, notas e pesquisas continuam sendo arquivos seus e moldam a forma como os agentes pensam.
- **Revisão unificada**: os commits, logs e diffs de todos os agentes em um só lugar.
- **Portões de aprovação**: aprovação explícita antes que os agentes executem comandos sensíveis ou operações em arquivos.
- **Workflow Git integrado**: workflow completo de diff e PR sem sair do app.

## Começando

### App Desktop

Baixe e instale. É grátis durante o beta e funciona com sua assinatura Claude Code / Codex.

| Plataforma | Link |
|------------|------|
| macOS (Apple Silicon) | [Baixar .dmg](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [Baixar .dmg](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [Baixar .exe](https://github.com/n-asuy/chro/releases/latest) |

### CLI (Navegador + Servidor local)

Execute o Chro no navegador sem o app desktop. Você também conta com comandos para gerenciar tarefas.

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

Execute `npx @chro-ai/cli --help` para a referência completa de comandos.

## Início rápido

### 1. Abra um projeto

Inicie o Chro e abra qualquer repositório Git como workspace. Seus arquivos locais passam a ser o contexto de conhecimento dos agentes.

### 2. Crie uma tarefa

Inicie uma nova sessão e descreva o que você quer: uma funcionalidade, uma correção de bug, uma refatoração. Anexe notas ou arquivos como contexto adicional.

### 3. Lance agentes

Atribua um ou mais agentes à tarefa. Cada agente começa imediatamente em seu próprio worktree Git. Acompanhe o progresso em tempo real pela timeline.

### 4. Revise e faça merge

Percorra os commits e diffs de cada agente. Aprove as partes desejadas, descarte o resto e faça o merge, tudo sem sair do Chro.

## Arquitetura

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

| Camada | Stack |
|--------|-------|
| Desktop | Electron 38 |
| Frontend | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| Conteúdo | Arquivos Markdown-first, frontmatter, WYSIWYG com CodeMirror 6, Monaco Editor |
| Dados | SQLite + SQLx localmente, D1 na nuvem |
| Backend | Rust, Axum 0.7, Tokio, JSON-RPC, WebSocket |
| Build | Bun, Turborepo, Biome |

## Desenvolvimento

**Pré-requisitos:** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

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

## Segurança e privacidade

O Chro é local-first por design. Seu conhecimento, suas notas e seu código permanecem na sua máquina. Os agentes rodam em worktrees isolados com aprovações explícitas, e nada chega à sua branch principal sem seu consentimento. O Chro não é afiliado à Anthropic. Consulte [SECURITY.md](../../SECURITY.md) para relatar vulnerabilidades.

## Licença

Veja [LICENSE](../../LICENSE.md) para detalhes.
