<p align="center">
  <img src="../../banner.jpg" alt="Chro – Füttere dein Wissen, erschaffe parallel" width="100%">
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

Chro ist ein Workspace, in dem du Coding-Agents parallel laufen lässt und entscheidest, was ihre Arbeit wert ist. Du beschreibst das gewünschte Ergebnis, Agenten arbeiten in isolierten Git-Worktrees, und ihre Änderungen kommen als Live-Diffs zurück. Nichts erreicht deinen Branch, bevor du es freigibst.

Chro funktioniert mit den Agent-Abos, die du bereits hast (**Claude Code**, **Codex**), und behält alles auf deinem Rechner: deine Notizen, deine Repositories, deine Historie.

## Designprinzipien

Chro hat eine klare Haltung. Das sind die Überzeugungen dahinter.

### Agenten editieren, du entscheidest

Chro ist kein Editor und konkurriert nicht mit deiner IDE. In Chro besteht die menschliche Arbeit darin, Agenten zu steuern, ihre Ergebnisse zu prüfen und das Wissen zu kuratieren, aus dem sie schöpfen. Dateien von Hand zu bearbeiten ist die Ausnahme, nicht die Prämisse. Jede Designentscheidung unten folgt aus dieser Umkehrung.

### Die Arbeitseinheit ist die Session, nicht die Datei

Eine IDE stellt den Dateibaum an die erste Stelle, weil Dateien das sind, worauf du operierst. In Chro ist das primäre Objekt die laufende Session, deshalb liest sich der Bildschirm von links nach rechts als *wer → Dialog → Belege*:

- **Links: wer arbeitet.** Sessions und Agenten über alle Projekte hinweg. Das ist die Navigation, die du am häufigsten berührst, deshalb bekommt sie die primäre Position.
- **Mitte: der Dialog.** Das Gespräch mit dem Agenten ist die Arbeit selbst, kein Nebenkanal.
- **Rechts: die Belege.** Dateien, Suche und Git leben in einem gemeinsamen Inspektions-Dock. Du greifst danach, um zu verifizieren, was ein Agent getan hat, nicht als Ausgangspunkt der Arbeit.

### Sandboxes gehören den Agenten, der kanonische Branch gehört dir

Jeder Agent läuft in einem wegwerfbaren Worktree, sodass dein Branch unangetastet bleibt, während beliebig viele Agenten gleichzeitig arbeiten. Diese Unterscheidung ist ein Ausführungsdetail und darf nicht in dein mentales Modell durchsickern:

- **Du betrittst eine Sandbox zum Review**, vor allem über Diffs und Commits. Sie ist eine Oberfläche, auf der überwiegend gelesen wird.
- **Alles, was du selbst verfasst, landet auf der kanonischen Seite**: Notizen, Dokumente, strukturierte Ansichten (`.cbase`), Diagramme. Eine Notiz zu schreiben sollte nie die Entscheidung erfordern, zu welchem Worktree sie gehört.

### Wissen sind Dateien unter Versionskontrolle

Dein Kontext besteht aus einfachen Dateien in einem Git-Repository: Markdown-Notizen, Frontmatter, strukturierte Ansichten, Diagramme. Kein proprietäres Silo, kein Exportschritt. Genau das macht das Wissen dauerhaft (es wird versioniert wie Code), portabel (es lässt sich klonen wie Code) und nützlich (Agenten lesen es genauso wie du).

### Nichts landet ohne Zustimmung

Agenten schlagen vor, du entscheidest. Sensible Befehle und Dateioperationen warten hinter Freigabeschritten, Diffs sind sichtbar, während der Agent noch läuft, und Mergen ist immer ein expliziter Akt. Parallelität ist nur deshalb sicher, weil jedes Ergebnis bis zum Review in Quarantäne bleibt.

## Funktionen

- **Parallele Agent-Orchestrierung**: starte mehrere Agenten aus einer einzigen Aufgabe. Jeder bekommt seine eigene Worktree-Sandbox und eine Timeline in Echtzeit.
- **Worktree-Isolation**: jeder Agent läuft in einem dedizierten Git-Worktree, sodass dein Branch bis zum Merge geschützt bleibt.
- **Local-first-Wissen**: deine Ideen, Notizen und Recherchen bleiben als Dateien in deinem Besitz und prägen, wie Agenten denken.
- **Vereinheitlichtes Review**: die Commits, Logs und Diffs aller Agenten an einem Ort.
- **Freigabeschritte**: ausdrückliche Freigabe, bevor Agenten sensible Befehle oder Dateioperationen ausführen.
- **Integrierter Git-Workflow**: vollständiger Diff- und PR-Workflow, ohne die App zu verlassen.

## Erste Schritte

### Desktop-App

Herunterladen und installieren, während der Beta kostenlos. Funktioniert mit deinem Claude Code / Codex-Abonnement.

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

Starte Chro und öffne ein beliebiges Git-Repository als Workspace. Deine lokalen Dateien werden zum Wissenskontext für die Agenten.

### 2. Aufgabe erstellen

Starte eine neue Session und beschreibe, was du möchtest: ein Feature, einen Bugfix oder ein Refactoring. Hänge bei Bedarf Notizen oder Dateien als zusätzlichen Kontext an.

### 3. Agents starten

Weise der Aufgabe einen oder mehrere Agents zu. Jeder Agent startet in seinem eigenen Git-Worktree und beginnt sofort zu arbeiten. Verfolge den Fortschritt in Echtzeit über die Timeline.

### 4. Überprüfen und mergen

Gehe die Commits und Diffs jedes Agenten durch. Gib die gewünschten Teile frei, verwerfe den Rest und merge alles, ohne Chro zu verlassen.

## Architektur

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

| Schicht | Stack |
|---------|-------|
| Desktop | Electron 38 |
| Frontend | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| Inhalte | Markdown-first-Dateien, Frontmatter, CodeMirror 6 WYSIWYG, Monaco Editor |
| Daten | SQLite + SQLx lokal, D1 in der Cloud |
| Backend | Rust, Axum 0.7, Tokio, JSON-RPC, WebSocket |
| Build | Bun, Turborepo, Biome |

## Entwicklung

**Voraussetzungen:** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # Abhängigkeiten installieren
bun dev:desktop      # Vollständige Desktop-App starten (Rust + Vite + Electron)
bun dev:cli          # CLI-Flow starten (Browser-UI + lokaler Server)
```

```bash
bun test             # Tests ausführen
bun lint             # Lint mit Biome
bun typecheck        # TypeScript-Typprüfung
```

## Sicherheit und Datenschutz

Chro ist von Grund auf local-first. Dein Wissen, deine Notizen und dein Code bleiben auf deinem Rechner. Agenten laufen in isolierten Worktrees mit expliziten Freigaben, und ohne deine Zustimmung gelangt nichts in deinen Hauptbranch. Chro ist nicht mit Anthropic verbunden. Siehe [SECURITY.md](../../SECURITY.md) für Schwachstellenmeldungen.

## Lizenz

Siehe [LICENSE](../../LICENSE.md) für Details.
