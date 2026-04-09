<p align="center">
  <img src="../../banner.jpg" alt="Chro — Vos idées avancent en parallèle" width="100%">
</p>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../apps/desktop/assets/logo/logo_chro_invert_symbol.png">
  <source media="(prefers-color-scheme: light)" srcset="../../apps/desktop/assets/logo/logo_chro_symbol.png">
  <img alt="Chro" src="../../apps/desktop/assets/logo/logo_chro_symbol.png" width="50">
</picture>

# Chro

**Vos idées avancent en parallèle.**

Espace de travail IA local-first pour piloter des agents de code.<br/>
Lancez des agents en parallèle dans des worktrees isolés, suivez les diffs en direct et ne fusionnez que ce que vous validez.

[![Check](https://github.com/n-asuy/chro/actions/workflows/check.yml/badge.svg)](https://github.com/n-asuy/chro/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/License-see_LICENSE.md-blue.svg)](../../LICENSE.md)

[Site web](https://chro-ai.com) · [Télécharger](https://github.com/n-asuy/chro/releases/latest) · [Sécurité](../../SECURITY.md)

**[English](../../README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md) | [Español](README.es.md) | Français | [Português](README.pt-BR.md) | [Tiếng Việt](README.vi.md) | [Deutsch](README.de.md)**

</div>

## Qu'est-ce que Chro ?

Chro transforme vos notes, vos recherches et le contexte de votre projet en exécution IA parallèle. Depuis un seul écran de tâche, vous pouvez lancer plusieurs agents de code, chacun dans son propre worktree Git, sans toucher à votre branche principale tant que vous n'êtes pas prêt.

Plus besoin de jongler entre les terminaux. Plus besoin de gérer les worktrees à la main. Les agents diffusent logs et diffs en direct dans un éditeur unifié, et rien n'atteint la branche principale sans votre validation explicite. Fonctionne avec votre abonnement **Claude Code** ou **Codex**.

<p align="center">
  <img src="../../assets/demo1.png" alt="Espace de travail Chro 1" width="49%">
  <img src="../../assets/demo2.png" alt="Espace de travail Chro 2" width="49%">
</p>
<p align="center">
  <img src="../../assets/demo3.png" alt="Espace de travail Chro 3" width="49%">
  <img src="../../assets/demo4.png" alt="Espace de travail Chro 4" width="49%">
</p>

## Fonctionnalités

- **Orchestration parallèle d'agents** — lancez plusieurs agents depuis un seul écran de tâche. Chacun dispose de son propre worktree isolé et d'une timeline en temps réel.
- **Isolation par worktree** — chaque agent s'exécute dans un worktree Git dédié et votre branche principale reste intacte jusqu'à la fusion.
- **Connaissances local-first** — vos idées, notes et recherches restent dans des fichiers qui vous appartiennent. Ce contexte oriente la façon dont les agents réfléchissent et produisent.
- **Éditeur unifié** — consultez les commits, logs et ressources de tous les agents au même endroit, avec des diffs inline.
- **Étapes d'approbation** — les agents doivent obtenir votre accord explicite avant d'exécuter des commandes sensibles ou des opérations sur les fichiers.
- **Tableau Kanban** — organisez le travail visuellement avec des modes focus et aperçu.
- **Workflow Git intégré** — parcourez diffs et PR sans quitter l'application.

## Démarrage

### Application de bureau

Téléchargez et installez l'application. Elle est gratuite pendant la bêta et fonctionne avec votre abonnement Claude Code / Codex.

| Plateforme | Lien |
|------------|------|
| macOS (Apple Silicon) | [Télécharger .dmg](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [Télécharger .dmg](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [Télécharger .exe](https://github.com/n-asuy/chro/releases/latest) |

### CLI (Navigateur + Serveur local)

Exécutez Chro dans votre navigateur sans l'application de bureau. Vous disposez aussi de commandes pour gérer les tâches.

```bash
npx @chro-ai/cli                # Démarrer Chro (navigateur + serveur local)
```

```bash
npx @chro-ai/cli task list                              # Lister les tâches
npx @chro-ai/cli task create "Ajouter des tests auth"   # Créer une tâche
npx @chro-ai/cli task run <id>                          # Exécuter un agent sur une tâche
npx @chro-ai/cli task logs <id>                         # Voir les logs d'exécution
npx @chro-ai/cli task merge <id>                        # Fusionner les modifications de l'agent
```

Exécutez `npx @chro-ai/cli --help` pour la référence complète des commandes.

## Démarrage rapide

### 1. Ouvrir un projet

Lancez Chro et ouvrez n'importe quel dépôt Git comme espace de travail. Vos fichiers locaux deviennent le contexte sur lequel les agents s'appuient pour travailler.

### 2. Créer une tâche

Utilisez le tableau Kanban pour créer une tâche. Décrivez ce que vous voulez: une fonctionnalité, un correctif ou un refactoring. Ajoutez des notes ou des fichiers si vous avez besoin de plus de contexte.

### 3. Lancer les agents

Assignez un ou plusieurs agents à la tâche. Chaque agent démarre immédiatement dans son propre worktree Git. Suivez la progression en temps réel via la timeline.

### 4. Réviser et fusionner

Parcourez les commits et diffs de chaque agent dans l'éditeur unifié. Validez ce que vous gardez, écartez le reste et fusionnez, le tout sans quitter Chro.

## Architecture

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

| Couche | Stack |
|--------|-------|
| Bureau | Electron 38 |
| Frontend | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| Éditeur | CodeMirror 6, Monaco Editor |
| Backend (local) | Rust, Axum 0.7, Tokio, SQLx (SQLite) |
| Backend (cloud) | Rust → WASM, Cloudflare Workers, D1 |
| Build | Bun, Turborepo, Biome |

## Développement

**Prérequis :** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # Installer les dépendances
bun dev:desktop      # Démarrer l'app de bureau complète (Rust + Vite + Electron)
```

```bash
bun test             # Exécuter les tests
bun lint             # Lint avec Biome
bun typecheck        # Vérification de types TypeScript
```

## Sécurité et confidentialité

Chro adopte une approche local-first. Vos connaissances, vos notes et votre code restent sur votre machine. Les agents s'exécutent dans des worktrees isolés, et rien n'atteint votre branche principale sans votre consentement explicite. Chro n'est pas affilié à Anthropic. Consultez [SECURITY.md](../../SECURITY.md) pour signaler une vulnérabilité.

## Licence

Voir [LICENSE](../../LICENSE.md) pour les détails.
