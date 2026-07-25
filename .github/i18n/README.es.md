<p align="center">
  <img src="../../banner.jpg" alt="Chro — Alimenta tu conocimiento, crea en paralelo" width="100%">
</p>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../apps/desktop/assets/logo/logo_chro_invert_symbol.png">
  <source media="(prefers-color-scheme: light)" srcset="../../apps/desktop/assets/logo/logo_chro_symbol.png">
  <img alt="Chro" src="../../apps/desktop/assets/logo/logo_chro_symbol.png" width="50">
</picture>

# Chro

**Tus ideas avanzan en paralelo.**

Espacio de trabajo de IA local-first para orquestar agentes de código.<br/>
Lanza agentes en paralelo en worktrees aislados, sigue los diffs en vivo y fusiona solo lo que apruebes.

[![Check](https://github.com/n-asuy/chro/actions/workflows/check.yml/badge.svg)](https://github.com/n-asuy/chro/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/License-see_LICENSE.md-blue.svg)](../../LICENSE.md)

[Sitio web](https://chro-ai.com) · [Descargar](https://github.com/n-asuy/chro/releases/latest) · [Seguridad](../../SECURITY.md)

**[English](../../README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md) | Español | [Français](README.fr.md) | [Português](README.pt-BR.md) | [Tiếng Việt](README.vi.md) | [Deutsch](README.de.md)**

</div>

## ¿Qué es Chro?

Chro es un espacio de trabajo para ejecutar agentes de código en paralelo y decidir cuánto vale su trabajo. Tú describes el resultado que quieres, los agentes lo ejecutan en worktrees de Git aislados y sus cambios vuelven en forma de diffs en vivo. Nada llega a tu rama hasta que lo apruebas.

Funciona con las suscripciones de agentes que ya tienes (**Claude Code**, **Codex**) y mantiene todo en tu máquina: tus notas, tus repositorios, tu historial.

## Principios de diseño

Chro tiene opiniones firmes. Estas son esas opiniones.

### Los agentes editan, tú decides

Chro no es un editor y no compite con tu IDE. En Chro, el trabajo humano consiste en dirigir agentes, revisar lo que producen y curar el conocimiento del que se nutren. Editar archivos a mano es la excepción, no la premisa. Todas las decisiones de diseño que siguen se derivan de esta inversión.

### La unidad de trabajo es la sesión, no el archivo

Un IDE pone el árbol de archivos en primer plano porque los archivos son aquello sobre lo que operas. En Chro el objeto principal es la sesión en ejecución, así que la pantalla se lee de izquierda a derecha como *quién → diálogo → evidencia*:

- **Izquierda: quién está trabajando.** Sesiones y agentes de todos los proyectos. Es la navegación que más usas, por eso ocupa la posición principal.
- **Centro: el diálogo.** La conversación con el agente es el trabajo en sí, no un canal secundario.
- **Derecha: la evidencia.** Archivos, búsqueda y Git conviven en un único panel de inspección. Recurres a ellos para verificar lo que hizo un agente, no como punto de partida del trabajo.

### Los sandboxes pertenecen a los agentes, la rama canónica te pertenece a ti

Cada agente se ejecuta en un worktree desechable, de modo que tu rama permanece intacta mientras cualquier número de agentes trabaja a la vez. Esa distinción es un detalle de ejecución y no debe filtrarse a tu modelo mental:

- **Entras en un sandbox para revisar**, principalmente a través de diffs y commits. Es una superficie pensada sobre todo para lectura.
- **Todo lo que escribes tú mismo aterriza en el lado canónico**: notas, documentos, vistas estructuradas (`.cbase`), diagramas. Escribir una nota nunca debería exigir decidir a qué worktree pertenece.

### El conocimiento son archivos bajo control de versiones

Tu contexto son archivos planos en un repositorio Git: notas Markdown, frontmatter, vistas estructuradas, diagramas. Sin silos propietarios ni pasos de exportación. Eso es lo que hace que el conocimiento sea duradero (se versiona como el código), portable (se clona como el código) y útil (los agentes lo leen igual que tú).

### Nada aterriza sin consentimiento

Los agentes proponen, tú dispones. Los comandos sensibles y las operaciones sobre archivos esperan tras puertas de aprobación, los diffs son visibles mientras el agente todavía está en marcha y el merge es siempre un acto explícito. El paralelismo solo es seguro porque cada resultado queda en cuarentena hasta que se revisa.

## Características

- **Orquestación paralela de agentes**: lanza varios agentes desde una única tarea. Cada uno cuenta con su propio sandbox de worktree y una línea de tiempo en tiempo real.
- **Aislamiento por worktree**: cada agente se ejecuta en un worktree de Git dedicado, y tu rama sigue protegida hasta que hagas el merge.
- **Conocimiento local-first**: tus ideas, notas e investigación siguen siendo archivos tuyos y dan forma a cómo piensan los agentes.
- **Revisión unificada**: los commits, logs y diffs de todos los agentes en un solo lugar.
- **Puertas de aprobación**: aprobación explícita antes de que los agentes ejecuten comandos sensibles u operaciones sobre archivos.
- **Flujo Git integrado**: flujo completo de diffs y PR sin salir de la app.

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

Inicia Chro y abre cualquier repositorio Git como espacio de trabajo. Tus archivos locales se convierten en el contexto de conocimiento de los agentes.

### 2. Crea una tarea

Inicia una nueva sesión y describe lo que quieres: una funcionalidad, una corrección de bug o una refactorización. Adjunta notas o archivos como contexto adicional.

### 3. Lanza agentes

Asigna uno o más agentes a la tarea. Cada agente arranca en su propio worktree de Git y empieza a trabajar de inmediato. Observa el progreso en tiempo real a través de la línea de tiempo.

### 4. Revisa y fusiona

Recorre los commits y diffs de cada agente. Aprueba las partes que quieras, descarta el resto y haz el merge, todo sin salir de Chro.

## Arquitectura

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

| Capa | Stack |
|------|-------|
| Escritorio | Electron 38 |
| Frontend | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| Contenido | Archivos Markdown-first, frontmatter, CodeMirror 6 WYSIWYG, Monaco Editor |
| Datos | SQLite + SQLx en local, D1 en la nube |
| Backend | Rust, Axum 0.7, Tokio, JSON-RPC, WebSocket |
| Build | Bun, Turborepo, Biome |

## Desarrollo

**Requisitos previos:** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # Instalar dependencias
bun dev:desktop      # Iniciar app de escritorio completa (Rust + Vite + Electron)
bun dev:cli          # Iniciar flujo CLI (UI en navegador + servidor local)
```

```bash
bun test             # Ejecutar tests
bun lint             # Lint con Biome
bun typecheck        # Verificación de tipos TypeScript
```

## Seguridad y privacidad

Chro está diseñado con un enfoque local-first. Tu conocimiento, tus notas y tu código permanecen en tu máquina. Los agentes se ejecutan en worktrees aislados con aprobaciones explícitas, y nada llega a tu rama principal sin tu consentimiento. No está afiliado a Anthropic. Consulta [SECURITY.md](../../SECURITY.md) para reportar vulnerabilidades.

## Licencia

Consulta [LICENSE](../../LICENSE.md) para más detalles.
