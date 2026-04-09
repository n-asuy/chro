<p align="center">
  <img src="../../banner.jpg" alt="Chro — Deine Ideen laufen parallel" width="100%">
</p>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../apps/desktop/assets/logo/logo_chro_invert_symbol.png">
  <source media="(prefers-color-scheme: light)" srcset="../../apps/desktop/assets/logo/logo_chro_symbol.png">
  <img alt="Chro" src="../../apps/desktop/assets/logo/logo_chro_symbol.png" width="50">
</picture>

# Chro

**Deine Ideen laufen parallel.**

Local-first AI-Workspace zur Orchestrierung von Coding-Agents.<br/>
Starte Agenten parallel in isolierten Worktrees, verfolge Diffs live und merge nur die Änderungen, die du freigibst.

[![Check](https://github.com/n-asuy/chro/actions/workflows/check.yml/badge.svg)](https://github.com/n-asuy/chro/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/License-see_LICENSE.md-blue.svg)](../../LICENSE.md)

[Website](https://chro-ai.com) · [Download](https://github.com/n-asuy/chro/releases/latest) · [Sicherheit](../../SECURITY.md)

**[English](../../README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [Tiếng Việt](README.vi.md) | Deutsch**

</div>

## Was ist Chro?

Chro verwandelt deine Notizen, Recherchen und deinen Projektkontext in parallele KI-Ausführung. Von einer einzigen Aufgabenansicht aus startest du mehrere Coding-Agenten, die jeweils in ihrem eigenen Git-Worktree laufen. Dein Hauptbranch bleibt unangetastet, bis du bereit bist.

Kein Hin- und Herwechseln zwischen Terminals. Kein manuelles Verwalten von Worktrees. Deine Agenten streamen Logs und Diffs live in einen gemeinsamen Editor, und ohne deine ausdrückliche Freigabe landet nichts im Hauptbranch. Funktioniert mit deinem bestehenden **Claude Code**- oder **Codex**-Abo.

<p align="center">
  <img src="../assets/demo1.png" alt="Chro Workspace 1" width="49%">
  <img src="../assets/demo2.png" alt="Chro Workspace 2" width="49%">
</p>
<p align="center">
  <img src="../assets/demo3.png" alt="Chro Workspace 3" width="49%">
  <img src="../assets/demo4.png" alt="Chro Workspace 4" width="49%">
</p>

## Funktionen

- **Parallele Agent-Orchestrierung** — starte mehrere Agenten von einer einzigen Aufgabenansicht aus. Jeder hat seine eigene Worktree-Sandbox und eine Timeline in Echtzeit.
- **Worktree-Isolation** — jeder Agent läuft in einem dedizierten Git-Worktree, sodass dein Hauptbranch bis zum Merge geschützt bleibt.
- **Local-first-Wissen** — deine Ideen, Notizen und Recherchen bleiben als Dateien in deinem Besitz. Dieser Kontext prägt, wie Agenten denken und arbeiten.
- **Gemeinsamer Editor** — prüfe Commits, Logs und Assets aller Agenten an einem Ort mit Inline-Diffs.
- **Freigabeschritte** — bevor Agenten sensible Befehle oder Dateioperationen ausführen, ist deine ausdrückliche Freigabe erforderlich.
- **Kanban-Board** — organisiere Arbeit visuell mit Fokus- und Vorschau-Modi.
- **Integrierter Git-Workflow** — gehe Diffs und PRs durch, ohne die App zu verlassen.

## Erste Schritte

### Desktop-App

Herunterladen und installieren. Während der Beta ist die App kostenlos und funktioniert mit deinem Claude Code / Codex-Abonnement.

| Plattform | Link |
|-----------|------|
| macOS (Apple Silicon) | [.dmg herunterladen](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [.dmg herunterladen](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [.exe herunterladen](https://github.com/n-asuy/chro/releases/latest) |

### CLI (Browser + Lokaler Server)

Führe Chro im Browser ohne Desktop-App aus. Außerdem bekommst du Befehle zur Aufgabenverwaltung.

```bash
npx @chro-ai/cli                # Chro starten (Browser + lokaler Server)
```

```bash
npx @chro-ai/cli task list                              # Aufgaben auflisten
npx @chro-ai/cli task create "Unit-Tests für Auth"      # Aufgabe erstellen
npx @chro-ai/cli task run <id>                          # Agent auf Aufgabe ausführen
npx @chro-ai/cli task logs <id>                         # Ausführungslogs anzeigen
npx @chro-ai/cli task merge <id>                        # Agent-Änderungen mergen
```

Führe `npx @chro-ai/cli --help` für die vollständige Befehlsreferenz aus.

## Schnellstart

### 1. Projekt öffnen

Starte Chro und öffne ein beliebiges Git-Repository als Workspace. Deine lokalen Dateien werden zum Kontext, auf den sich die Agenten bei der Arbeit stützen.

### 2. Aufgabe erstellen

Erstelle eine Aufgabe im Kanban-Board. Beschreibe, was du möchtest: ein Feature, einen Bugfix oder ein Refactoring. Bei Bedarf kannst du Notizen oder Dateien als zusätzlichen Kontext anhängen.

### 3. Agents starten

Weise der Aufgabe einen oder mehrere Agents zu. Jeder Agent beginnt sofort in seinem eigenen Git-Worktree zu arbeiten. Verfolge den Fortschritt in Echtzeit über die Timeline.

### 4. Überprüfen und mergen

Gehe die Commits und Diffs jedes Agenten im gemeinsamen Editor durch. Gib die gewünschten Teile frei, verwerfe den Rest und merge alles, ohne Chro zu verlassen.

## Architektur

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

| Schicht | Stack |
|---------|-------|
| Desktop | Electron 38 |
| Frontend | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| Editor | CodeMirror 6, Monaco Editor |
| Backend (lokal) | Rust, Axum 0.7, Tokio, SQLx (SQLite) |
| Backend (Cloud) | Rust → WASM, Cloudflare Workers, D1 |
| Build | Bun, Turborepo, Biome |

## Entwicklung

**Voraussetzungen:** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # Abhängigkeiten installieren
bun dev:desktop      # Vollständige Desktop-App starten (Rust + Vite + Electron)
```

```bash
bun test             # Tests ausführen
bun lint             # Lint mit Biome
bun typecheck        # TypeScript-Typprüfung
```

## Sicherheit und Datenschutz

Chro ist nach dem Local-first-Prinzip gebaut. Dein Wissen, deine Notizen und dein Code bleiben auf deinem Rechner. Agenten laufen in isolierten Worktrees, und ohne deine ausdrückliche Zustimmung gelangt nichts in deinen Hauptbranch. Chro ist nicht mit Anthropic verbunden. Siehe [SECURITY.md](../../SECURITY.md) für Schwachstellenmeldungen.

## Lizenz

Siehe [LICENSE](../../LICENSE.md) für Details.
