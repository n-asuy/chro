<p align="center">
  <img src="../../banner.jpg" alt="Chro — アイデアが並列で動き出す" width="100%">
</p>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../apps/desktop/assets/logo/logo_chro_invert_symbol.png">
  <source media="(prefers-color-scheme: light)" srcset="../../apps/desktop/assets/logo/logo_chro_symbol.png">
  <img alt="Chro" src="../../apps/desktop/assets/logo/logo_chro_symbol.png" width="50">
</picture>

# Chro

**アイデアが並列で動き出す。**

コーディングエージェントをオーケストレーションする、ローカルファーストのAIワークスペース。<br/>
隔離された worktree でエージェントを並列に起動し、ライブ diff を確認しながら、承認した変更だけをマージできます。

[![Check](https://github.com/n-asuy/chro/actions/workflows/check.yml/badge.svg)](https://github.com/n-asuy/chro/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/License-see_LICENSE.md-blue.svg)](../../LICENSE.md)

[ウェブサイト](https://chro-ai.com) · [ダウンロード](https://github.com/n-asuy/chro/releases/latest) · [セキュリティ](../../SECURITY.md)

**[English](../../README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [Tiếng Việt](README.vi.md) | [Deutsch](README.de.md)**

</div>

## Chroとは？

Chroは、コーディングエージェントを並列に動かし、その成果に価値があるかを判断するためのワークスペースです。あなたが望む成果を記述すると、エージェントは隔離された Git worktree の中で実行し、その変更はライブ diff としてストリーミングされます。承認するまで、あなたのブランチには何も入りません。

お手持ちのエージェントのサブスクリプション（**Claude Code**、**Codex**）でそのまま使え、メモもリポジトリも履歴も、すべてが手元のマシンに保たれます。

## 設計原則

Chroには明確な主張があります。それが以下の原則です。

### エージェントが編集し、あなたが決める

ChroはエディタではなくIDEと競合するものでもありません。Chroにおける人間の仕事は、エージェントに指示を出し、その成果物をレビューし、エージェントが参照するナレッジをキュレーションすることです。手作業でファイルを編集するのは例外であって、前提ではありません。以下の設計判断はすべて、この逆転から導かれています。

### 作業の単位はセッションであり、ファイルではない

IDEがファイルツリーを最前面に置くのは、ファイルこそが操作対象だからです。Chroの主役は実行中のセッションであり、画面は左から右へ「誰が → 対話 → 証拠」と読めるように構成されています。

- **左：誰が働いているか。** 全プロジェクトを横断したセッションとエージェント。最も触れるナビゲーションなので、最も優先される位置に置かれます。
- **中央：対話。** エージェントとの会話はサイドチャネルではなく、作業そのものです。
- **右：証拠。** ファイル、検索、Git はひとつのインスペクションドックにまとまっています。エージェントが何をしたかを検証するために手を伸ばす場所であって、作業の起点ではありません。

### sandbox はエージェントのもの、正規のブランチはあなたのもの

各エージェントは使い捨ての worktree で動作するため、何体のエージェントが同時に働いても、あなたのブランチは手つかずのまま保たれます。この区別は実行上の詳細であり、あなたのメンタルモデルに漏れ出してはいけません。

- **sandbox に立ち入るのはレビューのため**です。主に diff とコミットを通して確認する、読み取り中心の場です。
- **あなた自身が書くものは、すべて正規の側に置かれます。** メモ、ドキュメント、構造化ビュー（`.cbase`）、ダイアグラム。メモを書くたびに、どの worktree に置くべきか悩む必要はありません。

### ナレッジはバージョン管理下のファイル

あなたのコンテキストは、Git リポジトリ内のプレーンなファイルです。Markdown のメモ、frontmatter、構造化ビュー、ダイアグラム。独自形式のサイロも、エクスポートの手間もありません。だからこそナレッジは、コードと同じようにバージョン管理でき（永続性）、コードと同じようにクローンでき（可搬性）、エージェントもあなたと同じように読める（有用性）のです。

### 同意なしには何も入らない

エージェントが提案し、あなたが裁定します。機密性の高いコマンドやファイル操作は承認ゲートで待機し、diff はエージェントの実行中から確認でき、マージは常に明示的な操作です。並列実行が安全なのは、すべての成果がレビューされるまで隔離されているからです。

## 機能

- **並列エージェントオーケストレーション**：1つのタスクから複数のエージェントを起動。各エージェントは独自の worktree サンドボックスとリアルタイムのタイムラインを持ちます。
- **Worktree分離**：各エージェントは専用の Git worktree で動作し、マージするまでブランチは安全に保たれます。
- **ローカルファーストのナレッジ**：アイデアやメモ、リサーチは自分のファイルとして手元に残り、エージェントの思考を形づくります。
- **統合レビュー**：すべてのエージェントのコミット、ログ、diff を1か所に集約します。
- **承認ゲート**：エージェントが機密性の高いコマンドやファイル操作を実行する前に、明示的な承認が必要です。
- **組み込みGitワークフロー**：アプリを離れずに、diff の確認から PR まで進められます。

## はじめに

### デスクトップアプリ

ダウンロードしてインストールできます。ベータ期間中は無料で、Claude Code / Codex のサブスクリプションで利用できます。

| プラットフォーム | リンク |
|------------------|--------|
| macOS (Apple Silicon) | [.dmgをダウンロード](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [.dmgをダウンロード](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [.exeをダウンロード](https://github.com/n-asuy/chro/releases/latest) |

### CLI（ブラウザ + ローカルサーバー）

デスクトップアプリがなくても、ブラウザで Chro を動かせます。タスク管理用のコマンドも用意しています。

```bash
npx @chro-ai/cli                # Chroを起動（ブラウザ + ローカルサーバー）
```

```bash
npx @chro-ai/cli task list                              # タスク一覧
npx @chro-ai/cli task create "認証モジュールのテスト追加"  # タスク作成
npx @chro-ai/cli task run <id>                          # エージェントでタスクを実行
npx @chro-ai/cli task logs <id>                         # 実行ログをストリーミング
npx @chro-ai/cli task merge <id>                        # エージェントの変更をマージ
```

詳しくは `npx @chro-ai/cli --help` をご覧ください。

## クイックスタート

### 1. プロジェクトを開く

Chroを起動し、任意の Git リポジトリをワークスペースとして開きます。ローカルのファイル群が、そのままエージェントのナレッジコンテキストになります。

### 2. タスクを作成

新しいセッションを開始し、やりたいことを記述します。新機能、バグ修正、リファクタリングなど。追加のコンテキストとして、メモやファイルも添付できます。

### 3. エージェントを起動

タスクに1つ以上のエージェントを割り当てます。各エージェントが独自の Git worktree で即座に作業を開始します。タイムラインでリアルタイムに進捗を確認できます。

### 4. レビューとマージ

各エージェントのコミットと diff を順に確認します。必要な変更だけを承認し、残りは捨ててからマージできます。すべて Chro 内で完結します。

## アーキテクチャ

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

| レイヤー | 技術スタック |
|----------|-------------|
| デスクトップ | Electron 38 |
| フロントエンド | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| コンテンツ | Markdown-first files, frontmatter, CodeMirror 6 WYSIWYG, Monaco Editor |
| データ | SQLite + SQLx locally, D1 in cloud |
| バックエンド | Rust, Axum 0.7, Tokio, JSON-RPC, WebSocket |
| ビルド | Bun, Turborepo, Biome |

## 開発

**前提条件:** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # 依存関係をインストール
bun dev:desktop      # デスクトップアプリをフル起動（Rust + Vite + Electron）
bun dev:cli          # CLIフローを起動（ブラウザUI + ローカルサーバー）
```

```bash
bun test             # テスト実行
bun lint             # Biomeでリント
bun typecheck        # TypeScript型チェック
```

## セキュリティとプライバシー

Chroはローカルファーストを前提に設計されています。ナレッジ、メモ、コードはすべて手元のマシンに保存されます。エージェントは隔離された worktree で明示的な承認のもと動作し、あなたの同意なしにメインブランチへ変更が入ることはありません。Anthropicとは無関係です。脆弱性の報告方法は [SECURITY.md](../../SECURITY.md) をご覧ください。

## ライセンス

詳細は[LICENSE](../../LICENSE.md)をご覧ください。
