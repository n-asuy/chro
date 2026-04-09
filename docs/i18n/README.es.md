<p align="center">
  <img src="../../banner.jpg" alt="Chro — Tus ideas avanzan en paralelo" width="100%">
</p>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../apps/desktop/assets/logo/logo_chro_invert_symbol.png">
  <source media="(prefers-color-scheme: light)" srcset="../../apps/desktop/assets/logo/logo_chro_symbol.png">
  <img alt="Chro" src="../../apps/desktop/assets/logo/logo_chro_symbol.png" width="50">
</picture>

# Chro

**Tus ideas avanzan en paralelo.**

Espacio de trabajo de IA local-first para coordinar agentes de código.<br/>
Lanza agentes en paralelo en worktrees aislados, sigue los diffs en vivo y fusiona solo los cambios que apruebes.

[![Check](https://github.com/n-asuy/chro/actions/workflows/check.yml/badge.svg)](https://github.com/n-asuy/chro/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/License-see_LICENSE.md-blue.svg)](../../LICENSE.md)

[Sitio web](https://chro-ai.com) · [Descargar](https://github.com/n-asuy/chro/releases/latest) · [Seguridad](../../SECURITY.md)

**[English](../../README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md) | Español | [Français](README.fr.md) | [Português](README.pt-BR.md) | [Tiếng Việt](README.vi.md) | [Deutsch](README.de.md)**

</div>

## ¿Qué es Chro?

Chro convierte tus notas, tu investigación y el contexto de tu proyecto en ejecución paralela de IA. Desde un único panel de tareas puedes lanzar varios agentes de código, cada uno en su propio worktree de Git, sin tocar la rama principal hasta que decidas hacerlo.

Sin ir saltando entre terminales. Sin gestionar worktrees a mano. Los agentes envían logs y diffs en tiempo real a un editor unificado, y nada llega a tu rama principal sin tu aprobación explícita. Funciona con tu suscripción actual de **Claude Code** o **Codex**.

<p align="center">
  <img src="../assets/demo1.png" alt="Espacio de trabajo Chro 1" width="49%">
  <img src="../assets/demo2.png" alt="Espacio de trabajo Chro 2" width="49%">
</p>
<p align="center">
  <img src="../assets/demo3.png" alt="Espacio de trabajo Chro 3" width="49%">
  <img src="../assets/demo4.png" alt="Espacio de trabajo Chro 4" width="49%">
</p>

## Características

- **Orquestación paralela de agentes** — inicia varios agentes desde un único panel de tareas. Cada uno cuenta con su propio sandbox de worktree y una línea de tiempo en tiempo real.
- **Aislamiento por worktree** — cada agente se ejecuta en un worktree de Git dedicado, y tu rama principal sigue protegida hasta que hagas el merge.
- **Conocimiento local-first** — tus ideas, notas e investigación siguen siendo archivos tuyos. Ese contexto guía cómo piensan y trabajan los agentes.
- **Editor unificado** — revisa commits, logs y archivos generados de todos los agentes en un solo lugar con diffs inline.
- **Aprobaciones obligatorias** — los agentes necesitan tu aprobación explícita antes de ejecutar comandos sensibles u operaciones sobre archivos.
- **Tablero Kanban** — organiza el trabajo visualmente con modos de enfoque y vista previa.
- **Flujo Git integrado** — recorre diffs y PR sin salir de la app.

## Primeros pasos

### Aplicación de escritorio

Descarga e instala. Es gratis durante la beta y funciona con tu suscripción de Claude Code / Codex.

| Plataforma | Enlace |
|------------|--------|
| macOS (Apple Silicon) | [Descargar .dmg](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [Descargar .dmg](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [Descargar .exe](https://github.com/n-asuy/chro/releases/latest) |

### CLI (Navegador + Servidor local)

Ejecuta Chro en tu navegador sin la aplicación de escritorio. También incluye comandos para gestionar tareas.

```bash
npx @chro-ai/cli                # Iniciar Chro (navegador + servidor local)
```

```bash
npx @chro-ai/cli task list                              # Listar tareas
npx @chro-ai/cli task create "Añadir tests para auth"   # Crear tarea
npx @chro-ai/cli task run <id>                          # Ejecutar agente en tarea
npx @chro-ai/cli task logs <id>                         # Ver logs de ejecución
npx @chro-ai/cli task merge <id>                        # Fusionar cambios del agente
```

Ejecuta `npx @chro-ai/cli --help` para la referencia completa de comandos.

## Inicio rápido

### 1. Abre un proyecto

Inicia Chro y abre cualquier repositorio Git como espacio de trabajo. Tus archivos locales pasan a ser el contexto que usan los agentes para trabajar.

### 2. Crea una tarea

Usa el tablero Kanban para crear una tarea. Describe lo que quieres: una funcionalidad, una corrección o una refactorización. Si hace falta, añade notas o archivos como contexto.

### 3. Lanza agentes

Asigna uno o más agentes a la tarea. Cada agente inicia inmediatamente en su propio worktree de Git. Observa el progreso en tiempo real a través de la línea de tiempo.

### 4. Revisa y fusiona

Revisa los commits y diffs de cada agente en el editor unificado. Aprueba las partes que quieras, descarta el resto y haz el merge, todo sin salir de Chro.

## Arquitectura

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

| Capa | Stack |
|------|-------|
| Escritorio | Electron 38 |
| Frontend | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| Editor | CodeMirror 6, Monaco Editor |
| Backend (local) | Rust, Axum 0.7, Tokio, SQLx (SQLite) |
| Backend (nube) | Rust → WASM, Cloudflare Workers, D1 |
| Build | Bun, Turborepo, Biome |

## Desarrollo

**Requisitos previos:** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # Instalar dependencias
bun dev:desktop      # Iniciar app de escritorio completa (Rust + Vite + Electron)
```

```bash
bun test             # Ejecutar tests
bun lint             # Lint con Biome
bun typecheck        # Verificación de tipos TypeScript
```

## Seguridad y privacidad

Chro está diseñado con un enfoque local-first. Tu conocimiento, tus notas y tu código permanecen en tu máquina. Los agentes se ejecutan en worktrees aislados y nada llega a tu rama principal sin tu consentimiento explícito. No está afiliado a Anthropic. Consulta [SECURITY.md](../../SECURITY.md) para reportar vulnerabilidades.

## Licencia

Consulta [LICENSE](../../LICENSE.md) para más detalles.
