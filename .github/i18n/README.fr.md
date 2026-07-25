<p align="center">
  <img src="../../banner.jpg" alt="Chro — Nourrissez vos connaissances, créez en parallèle" width="100%">
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

Chro est un espace de travail conçu pour exécuter des agents de code en parallèle et décider de la valeur de ce qu'ils produisent. Vous décrivez le résultat que vous voulez, les agents s'exécutent dans des worktrees Git isolés, et leurs modifications remontent sous forme de diffs en direct. Rien n'atteint votre branche tant que vous ne l'avez pas approuvé.

Il fonctionne avec les abonnements d'agents que vous possédez déjà (**Claude Code**, **Codex**) et garde tout sur votre machine : vos notes, vos dépôts, votre historique.

## Principes de conception

Chro a des opinions tranchées. Les voici.

### Les agents éditent, vous décidez

Chro n'est pas un éditeur et ne cherche pas à concurrencer votre IDE. Dans Chro, le travail humain consiste à diriger les agents, à réviser ce qu'ils produisent et à entretenir les connaissances dont ils se nourrissent. Éditer des fichiers à la main est l'exception, pas le postulat. Chaque décision de conception ci-dessous découle de cette inversion.

### L'unité de travail est la session, pas le fichier

Un IDE place l'arborescence de fichiers au premier plan parce que les fichiers sont ce sur quoi vous agissez. Dans Chro, l'objet principal est la session en cours d'exécution, si bien que l'écran se lit de gauche à droite comme *qui → dialogue → preuves* :

- **À gauche : qui travaille.** Les sessions et les agents de tous vos projets. C'est la navigation que vous utilisez le plus, elle occupe donc la position principale.
- **Au centre : le dialogue.** La conversation avec l'agent est le travail lui-même, pas un canal annexe.
- **À droite : les preuves.** Fichiers, recherche et Git vivent dans un même panneau d'inspection. Vous y allez pour vérifier ce qu'un agent a fait, pas comme point de départ du travail.

### Les sandbox appartiennent aux agents, la branche canonique vous appartient

Chaque agent s'exécute dans un worktree jetable : votre branche reste intacte pendant qu'un nombre quelconque d'agents travaillent en même temps. Cette distinction est un détail d'exécution, et elle ne doit pas contaminer votre modèle mental :

- **Vous entrez dans une sandbox pour réviser**, principalement à travers les diffs et les commits. C'est une surface essentiellement en lecture.
- **Tout ce que vous rédigez vous-même atterrit du côté canonique** : notes, documents, vues structurées (`.cbase`), diagrammes. Écrire une note ne devrait jamais exiger de choisir à quel worktree elle appartient.

### La connaissance, ce sont des fichiers sous contrôle de version

Votre contexte est constitué de fichiers ordinaires dans un dépôt Git : notes Markdown, frontmatter, vues structurées, diagrammes. Pas de silo propriétaire, pas d'étape d'export. C'est ce qui rend la connaissance durable (elle se versionne comme du code), portable (elle se clone comme du code) et utile (les agents la lisent de la même façon que vous).

### Rien n'atterrit sans consentement

Les agents proposent, vous disposez. Les commandes sensibles et les opérations sur les fichiers attendent derrière des étapes d'approbation, les diffs sont visibles pendant que l'agent travaille encore, et la fusion est toujours un acte explicite. Le parallélisme n'est sûr que parce que chaque résultat reste en quarantaine jusqu'à sa revue.

## Fonctionnalités

- **Orchestration parallèle d'agents** : lancez plusieurs agents depuis une seule tâche. Chacun dispose de sa propre sandbox worktree et d'une timeline en temps réel.
- **Isolation par worktree** : chaque agent s'exécute dans un worktree Git dédié, et votre branche reste protégée jusqu'à la fusion.
- **Connaissances local-first** : vos idées, notes et recherches restent des fichiers qui vous appartiennent, et façonnent la façon dont les agents réfléchissent.
- **Revue unifiée** : les commits, logs et diffs de chaque agent au même endroit.
- **Étapes d'approbation** : approbation explicite avant que les agents n'exécutent des commandes sensibles ou des opérations sur les fichiers.
- **Workflow Git intégré** : workflow complet de diffs et de PR sans quitter l'application.

## Démarrage

### Application de bureau

Téléchargez et installez, gratuit pendant la bêta. Fonctionne avec votre abonnement Claude Code / Codex.

| Plateforme | Lien |
|------------|------|
| macOS (Apple Silicon) | [Télécharger .dmg](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [Télécharger .dmg](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [Télécharger .exe](https://github.com/n-asuy/chro/releases/latest) |

### CLI (Navigateur + Serveur local)

Exécutez Chro dans votre navigateur sans l'application de bureau. Vous disposez aussi de commandes pour gérer les tâches.

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

Exécutez `npx @chro-ai/cli --help` pour la référence complète des commandes.

## Démarrage rapide

### 1. Ouvrir un projet

Lancez Chro et ouvrez n'importe quel dépôt Git comme espace de travail. Vos fichiers locaux deviennent le contexte de connaissances des agents.

### 2. Créer une tâche

Démarrez une nouvelle session et décrivez ce que vous voulez : une fonctionnalité, un correctif ou un refactoring. Ajoutez des notes ou des fichiers pour apporter du contexte supplémentaire.

### 3. Lancer les agents

Assignez un ou plusieurs agents à la tâche. Chaque agent démarre immédiatement dans son propre worktree Git. Suivez la progression en temps réel via la timeline.

### 4. Réviser et fusionner

Parcourez les commits et diffs de chaque agent. Approuvez ce que vous gardez, écartez le reste et fusionnez, le tout sans quitter Chro.

## Architecture

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

| Couche | Stack |
|--------|-------|
| Bureau | Electron 38 |
| Frontend | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| Contenu | Fichiers Markdown-first, frontmatter, WYSIWYG CodeMirror 6, Monaco Editor |
| Données | SQLite + SQLx en local, D1 dans le cloud |
| Backend | Rust, Axum 0.7, Tokio, JSON-RPC, WebSocket |
| Build | Bun, Turborepo, Biome |

## Développement

**Prérequis :** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

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

## Sécurité et confidentialité

Chro adopte une approche local-first par conception. Vos connaissances, vos notes et votre code restent sur votre machine. Les agents s'exécutent dans des worktrees isolés avec des approbations explicites, et rien n'atteint votre branche principale sans votre consentement. Chro n'est pas affilié à Anthropic. Consultez [SECURITY.md](../../SECURITY.md) pour signaler une vulnérabilité.

## Licence

Voir [LICENSE](../../LICENSE.md) pour les détails.
