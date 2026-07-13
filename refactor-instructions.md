# Chro リファクタリング指示書

作成日: 2026-06-12
対象リポジトリ: chro (Turborepo + Bun monorepo / Tauri 2 desktop + Rust backend)

この文書は実装担当モデルへの完結した作業指示書である。ここに書かれていない大規模変更を勝手に行ってはならない。

---

## Objective

既存仕様・既存挙動を一切壊さずに、以下を達成する。

1. 検証コマンドの整備 — 存在するのに実行されていないテストを検証パイプラインに接続し、baseline を確立する
2. 安全網の追加 — 今後触る箇所(ストリーム処理・ストア)に特性テスト(characterization test)を先に置く
3. 証拠のある負債の解消 — 命名の陳腐化、重複ユーティリティ、検証済み未使用依存の削除
4. 小さな責務分離 — god store / god component の段階的分割
5. 境界の明確化 — RPC クライアント層と JSON Patch ストリーム処理の共通化
6. 大きな設計変更は提案に留める — 本文書の「提案のみ」項目は実装しない

見た目の綺麗さは目的ではない。コード量が減り、変更しやすくなり、挙動が変わらないことが成功条件である。

---

## Project Understanding

### プロダクト
Chro はローカルファーストの AI コーディングエージェント・オーケストレーター。タスク画面から複数エージェント(Claude Code / Codex)を並列起動し、各エージェントは独立した Git worktree で動き、ライブログ・diff をストリーミングし、ユーザー承認を経てのみ main にマージされる。

### 主要ワークフロー(=絶対に壊せない体験)
1. プロジェクト(Gitリポジトリ)を開く → ワークスペースとしてファイルツリー表示
2. タスク作成 → エージェント割当て → worktree 生成 → 構造化プロトコルでエージェント実行
3. ライブストリーミング: ログ(JSON Patch over WebSocket)、diff、ターミナルスナップショット(canvas描画)
4. 承認ゲート(センシティブ操作の approval)
5. diff レビュー → マージ/破棄

### 構成と責務
```
apps/desktop/      Tauri 2 シェル + React 19 レンダラ(主製品)
  src/main.tsx               レンダラエントリ
  src-tauri/src/lib.rs       Rust シェル。chro-server を sidecar として spawn
  src/lib/desktop-shim.ts    window.desktop.* — Electron 時代の形を保つ Tauri ラッパ
  vite.config.ts             /rpc /streams /health 等を Rust backend に proxy。
                             napi-filesystem を .native/chro-filesystem.node としてロード
apps/cli/          Rust ランチャ(chro-server + Vite を起動、task サブコマンド)
apps/api/          Cloudflare Workers (Rust→WASM, D1)。waitlist/invite/Clerk 認証。
                   ローカルサーバとはコード共有なし(別ドメイン)
apps/mobile/       React Native プレースホルダ(実装ほぼなし)
packages/ui/       Radix + Tailwind 4 の共有コンポーネント(18個)
crates/ (19)       Cargo ワークスペースなし。各クレート独立
  server/  (~9.0k LOC)  Axum。routes/rpc/ に12ドメインルータ(~110 エンドポイント)
  db/      (~3.5k LOC)  SQLx + SQLite。migrations 6本。journal_mode=DELETE(意図的)
  executors/ (~11.1k)   Claude Code (headless stream-json) / Codex・pi (structured process protocol)
  local-runtime/ (~3.2k) 実行コンテナ、ログ捕捉、housekeeping
  runtime/ (~2.3k)      Runtime trait 抽象
  log-types/            ワイヤ型 (LogEntry: Stdout/Stderr/JsonPatch/SessionId/UiEvent/...)
  他: events, git, worktree, diff-stream, filesystem, napi-filesystem, approvals,
      config, analytics, image, file-search-cache, skills, browser
```

### データフロー
- フロント → `desktopFetch()` (`apps/desktop/src/lib/backend-client.ts:19-33`) → 11個の `*-client.ts` → `/rpc/*`
- ライブ更新: `/streams/*` WebSocket → RFC 6902 JSON Patch → `use-json-patch-ws-stream.ts` ほか複数フック
- バックエンドポートは動的。`/tmp/chro/chro.port` 経由で解決
- Rust↔TS のワイヤ型は手動同期(codegen なし)

---

## Behaviors To Preserve(壊してはいけない既存挙動)

1. タスク実行フロー全体: create → run(worktree内) → ログ/diff ストリーム → cancel → follow-up → merge
2. `/rpc/*`, `/streams/*` の URL パス・リクエスト/レスポンス JSON 形状・WebSocket メッセージ形式(`crates/log-types` の `LogEntry` を含む)
3. `window.desktop.*` / `window.__CHRO_RUNTIME__` の API 形状(`desktop-shim.ts` — 既存 React コードが依存)
4. sidecar 起動シーケンス: ポート探索 → `CHRO_PARENT_PID` → `/health` ポーリング → port ファイル書込(`apps/desktop/src-tauri/src/runtime/server.rs`)
5. SQLite スキーマと migration 履歴(`crates/db/migrations/`)・保存済みデータ互換性
6. `CLAUDECODE` / `CLAUDE_CODE_*` 環境変数のフィルタリング(`crates/executors/src/executors/claude.rs:353`)— 子プロセス起動の必須要件
7. WebSocket 再接続の指数バックオフと、ウィンドウ非表示時の `setTimeout(0)` バッチング(`use-json-patch-ws-stream.ts` — rAF 停止対策として意図的)
8. UI 原則: ユーザー操作なしに viewport がスクロール・ジャンプ・シフトしない(プロジェクト原則)
9. i18n: en / ja の文言は必ず同時に更新(片方だけの変更禁止)

## 既知の誤検出リスト(削除・修正してはならないもの)

過去の分析で「負債」と誤判定されたもの。証拠付きで否定済み。

| 見かけ上の問題 | 実際 |
|---|---|
| `crates/napi-filesystem` が未使用 | **使用中**。`apps/desktop/scripts/build-native-filesystem.mjs:10` がビルドし、`apps/desktop/vite.config.ts:20` が `.native/chro-filesystem.node` をロード |
| `path_resolve.rs` のリクエストパス内 `panic!` | `crates/server/src/routes/rpc/path_resolve.rs:156,168` は **`#[cfg(test)]` 内のテストヘルパー**。リクエストパスではない |
| CLAUDE 環境変数の無フィルタリング | フィルタは**実在**: `crates/executors/src/executors/claude.rs:353` |
| SQLite が DELETE journal で遅い → WAL 化すべき | DELETE は**意図的**(上流が WAL を試して revert した経緯)。変更禁止(Non-Negotiables 参照) |
| `use-json-patch-ws-stream.ts` の `setTimeout(0)` は雑 | ウィンドウ非表示時に rAF が止まる Chromium 挙動への意図的対策 |

---

## Non-Negotiables

- SQLite の `journal_mode(SqliteJournalMode::Delete)` (`crates/db/src/lib.rs:185`) を変更しない
- DB migration の既存ファイルを編集しない。新規 migration の追加もユーザー承認なしに行わない
- `/rpc` `/streams` のパス・ワイヤフォーマットを変更しない
- 依存ライブラリのバージョンアップをしない(削除は「検証済み未使用」のみ可)
- `apps/api`(課金・認証・waitlist)、`apps/mobile`、release 系 CI workflow(`cli-release.yml`, `desktop-release.yml`, `sync-oss.yml`, `oss-sanitization.yml`)に触れない
- コード内コメント・エラー名は英語(locale 文言を除く)
- プレースホルダー実装・パッチワーク禁止。TDD を基本とする
- 無関係なフォーマット変更をしない(biome は触ったファイルのみ)
- ファイル名は概念を表す命名にする(`_demo` 等の無意味な接尾辞禁止)

## Stop And Ask Conditions(実装を止めて質問する条件)

以下に該当したら、変更をコミットせず、状況と選択肢を報告して停止する。

1. 正しい仕様がコードからもテストからも判断できない
2. テストと実装が矛盾している(どちらが正かを勝手に決めない)
3. 削除候補のコードについて「未使用」の証拠が完全でない(grep だけでなく、ビルドスクリプト・vite config・Tauri config・GitHub workflow・`tooling/scripts/` まで確認して初めて完全)
4. 公開 API、DB schema、保存済みデータ(SQLite/D1/preferences/UI state)に影響しうる
5. 認証(Clerk)、課金、通知、外部連携(PostHog/Slack webhook)に影響しうる
6. ワイヤフォーマット(LogEntry, TerminalSnapshot, diff 型, JSON Patch 形状)の変更が必要に見える
7. 複数の設計案がありプロダクト判断が必要(例: バリデーションライブラリ導入、codegen 導入)
8. baseline で既に失敗しているテスト・チェックを発見した(自分の変更と混ぜずに即報告)
9. Phase の作業中に予定外のファイル群へ変更が波及し始めた

---

## Baseline Commands

最初に必ず実行し、結果を記録すること(Phase 0)。

```bash
git status                          # クリーンであること。未コミット変更があれば報告して停止
bun install

# TypeScript 側
bun run lint                        # turbo lint (biome) + sherif
bun run typecheck                   # turbo typecheck
bun run test                        # 注意: 現状 desktop の vitest は実行されない(下記 Debt-01)
                                    #   実体は apps/cli の "cargo test (server)" + mobile の jest
cd apps/desktop && bunx vitest run  # 38テストファイルの現状を記録(設定がなく失敗する可能性も記録)

# Rust 側(ワークスペースが無いためクレート個別。server のテストが最大)
cargo test --manifest-path crates/server/Cargo.toml
for c in db events executors local-runtime log-types runtime terminal worktree git filesystem config; do
  cargo test --manifest-path crates/$c/Cargo.toml || echo "FAILED: $c"
done
cargo fmt --all --check --manifest-path crates/server/Cargo.toml   # 参考
cargo clippy --manifest-path crates/server/Cargo.toml 2>&1 | tail -5  # 警告数を記録(直さない)

# E2E(任意・時間がかかる)
bun run test:e2e                    # e2e/smoke.spec.ts 1本のみ
```

CI (`.github/workflows/check.yml`) は **lint + typecheck のみ**。テストは CI で走っていない。これが前提条件である。

---

## Debt Map

各項目: 根拠 / なぜ負債か / 影響範囲 / リスク / 改善案 / 検証 / 実装可否。

### Debt-01: desktop の vitest がどの検証コマンドからも実行されていない 【最優先・実装可】
- 根拠: `apps/desktop/package.json` に `test` スクリプトがない(scripts を確認済み)。vitest は devDependencies にあるが vitest.config も vite.config 内 test 設定もない。`turbo test` は desktop をスキップする
- なぜ負債か: 38個のテストファイル(cbase 11、stores、json-patch-stream、canvas-terminal 等)が存在するのに回帰検知に使われていない。以降の全リファクタの安全網が事実上死んでいる
- 影響範囲: リポジトリ全体の検証体制
- リスク: 低(検証の追加のみ)。ただし長期間未実行のテストは現状で落ちる可能性がある — 落ちたら Stop And Ask 条件8
- 改善案: `apps/desktop/package.json` に `"test": "vitest run"` を追加し、必要最小限の vitest 設定(environment 指定等)を追加。`turbo test` で実行されることを確認
- 検証: `bun run test` で desktop テストが実行・通過すること

### Debt-02: JSON Patch ストリーム処理の重複 【実装可・テスト先行】
- 根拠: `use-task-log-stream.ts`(719行)、`use-conversation-history.ts`(896行)、`use-task-runs-stream.ts`、`use-task-sessions-stream.ts` がそれぞれ WS メッセージ解析・patch 適用を再実装。汎用版 `use-json-patch-ws-stream.ts` は存在する。`httpToWs()` が `project-client.ts:7-8` と `use-json-patch-ws-stream.ts:47-48` に重複
- なぜ負債か: プロトコル変更時に3箇所以上の修正が必要。patch 適用セマンティクスの不一致リスク
- 影響範囲: ライブログ・会話履歴・タスク一覧 — 製品のコア UX
- リスク: 中。ストール検知・再接続・バッチングの微妙な挙動を壊しやすい
- 改善案: `httpToWs` を1箇所へ。各フックの「WS接続+patch適用」部分を `use-json-patch-ws-stream` ベースへ段階的に寄せる。1フックずつ、挙動同一性をテストで担保しながら
- 検証: 既存 `use-task-log-stream.test.ts` `json-patch-stream.test.ts` + Phase 2 で追加する特性テスト。手動: タスク実行してログがリアルタイム表示・再接続が機能
- 可否: `httpToWs` 統一は即可。フック統合はテスト追加後のみ

### Debt-03: god component 群 【実装可・段階的】
- 根拠: `conversation-view.tsx` 2,207行 / `single-agent-session.tsx` 1,811行 / `settings-panel.tsx` 1,696行
- なぜ負債か: メッセージ描画・thinking 集約・diff 表示・展開状態などが1ファイルに混在。テスト不能、変更が常に高リスク
- 影響範囲: セッション画面全体
- リスク: 高。**過去に motion(Component)-in-render + Radix asChild ネストで無限 setState ループ("Something went wrong")を起こした履歴がある画面**。コンポーネント抽出時に render 内でのコンポーネント生成を絶対にしない(モジュールトップレベルで定義する)
- 改善案: まず純粋関数(thinking 集約、メッセージ整形)をユーティリティに抽出してテスト → 次に末端の表示コンポーネント(`ExpandableUserMessage` 等)をファイル分割。props 形状は変えない
- 検証: vitest + 手動でセッション実行・停止・スクロールを確認。実行中の停止操作を必ず試す
- 可否: 純粋関数抽出と単純なファイル分割のみ可。状態管理の再設計は提案に留める

### Debt-04: god store と責務混在 store 【実装可・テスト先行】
- 根拠: `files-store.ts` 1,088行(tree 変異・ファイル操作・workspace root 管理が混在)。`prompt-editor-store.ts` 839行(contenteditable の DOM 走査パーサ ~100行超 + store アクション)
- なぜ負債か: DOM パースは純粋ロジックであり store に置く理由がない。files-store は操作系と選択系が密結合
- 影響範囲: ファイルツリー全操作、プロンプト入力
- リスク: 中。files-store にはテストがない(layout 系 store にはある)
- 改善案: (a) prompt-editor の `parseFromDOM` 系を `session/lib/` の純粋モジュールへ抽出(既存 `parse-from-dom.test.ts` が安全網)。(b) files-store はまず現挙動のテストを書いてから、Tree / Operations の2分割を検討
- 検証: 既存+新規 vitest。手動: ファイル作成・リネーム・削除・コピー、@ メンション添付
- 可否: (a) 即可。(b) テスト追加まで分割禁止

### Debt-05: RPC クライアント層の重複と無検証キャスト 【一部実装可】
- 根拠: 11個の `*-client.ts` が `desktopFetch` + URL 組み立て + エラー処理を反復。`backend-client.ts:32` は `(await response.json()) as T` で実行時検証なし
- なぜ負債か: API 変更時の修正箇所が散在。Rust 側との型ズレが実行時まで発覚しない
- 影響範囲: 全 API 通信
- リスク: 低〜中(ヘルパー統合は機械的)
- 改善案: クエリパラメータ組み立て・エラー整形の共通ヘルパーを `backend-client.ts` に集約。**zod 等のランタイムバリデーション導入は設計判断なので提案のみ**(Stop And Ask 条件7)
- 検証: typecheck + 手動疎通(主要画面のロード)
- 可否: ヘルパー統合のみ可

### Debt-06: 陳腐化した Electron 痕跡 【実装可・安全】
- 根拠:
  - `src/types/electron.d.ts` — 中身は Tauri ブリッジ型なのに Electron という名前
  - コメント: `layout-shell.tsx:32`, `use-document-title.ts:8`, `project-tabs-header.tsx:169`, `executor-install.ts:26`
  - ユーザー可視文言: `i18n/locales/en.ts:89,108,112` / `ja.ts:86,104,108` の「Electron環境」
  - `canvas-terminal.ts:51` の xterm 言及コメント
  - root `package.json` の `electron-updater`(import なし — 確認済み)
- なぜ負債か: アーキテクチャを誤解させる。ユーザー向け文言として誤り
- リスク: 低。i18n は en/ja 同時更新が必須
- 改善案: `electron.d.ts` → `desktop-bridge.d.ts` へリネーム(参照更新)。コメント修正。i18n 文言を「デスクトップ環境」相当へ(en/ja 同時)。`electron-updater` は grep + ビルドスクリプト確認後に削除
- 検証: typecheck、`bun run build --filter=@chro/desktop`(build:vite まででも可)、文言の表示確認
- 可否: 即可

### Debt-07: 検証済み未使用依存・設定の残骸 【検証後に実装可】
- 根拠: root `package.json` の `drizzle-orm`/`drizzle-kit`/`@daytonaio/sdk`(いずれも import なしを grep で確認済み)、`react-xarrows`(要再確認)。`turbo.json` build.env の `REMOTION_*`, `DAYTONA_API_KEY`, `DUB_API_KEY` 等は消費箇所なし
- なぜ負債か: 依存監査・インストール時間・認知負荷
- リスク: 低。ただし削除前に各候補ごとに grep を `apps/ tooling/ .github/ docs/` 全体で再実行すること(誤検出リストの教訓)
- 改善案: 1依存=1コミットで削除。`turbo.json` env は消費実体のないものだけ削る
- 検証: `bun install` → lint/typecheck/build が通る
- 可否: 候補ごとの再検証を条件に可

### Debt-08: Rust エラーハンドリングの不均質と unwrap 密度 【triage のみ実装可】
- 根拠: thiserror が支配的(182箇所)だが anyhow 混在(local-runtime, runtime)。thiserror 1.0 と 2.0 が混在(server は 1.0、config/db は 2.0)。非テストコードの unwrap: filesystem 86 / local-runtime 84 / executors 76+expect 21 / config 53
- なぜ負債か: リクエストパス・実行パスでの panic はサーバごと落とす
- 影響範囲: バックエンド全体
- リスク: 機械的な全置換は挙動変更(エラー伝播の変化)になるため**禁止**
- 改善案: リクエストハンドラと spawn されたタスク内に限定して unwrap を列挙 → 実際に到達可能なものだけ `?` / 明示エラーへ。`local-runtime/src/container.rs:402-404` 周辺の `std::sync::Mutex` を await 跨ぎで保持していないかを確認し、保持していれば lock スコープを縮める
- 検証: 各クレートの cargo test + 手動でタスク実行フロー
- 可否: 個別 triage のみ可。一括置換禁止

### Debt-09: Rust 側の型重複(ワイヤ型) 【提案のみ】
- 根拠: `executors/src/executors/claude/types.rs` の `ClaudeTodoItem` / ActionType と `log-types/src/normalized.rs` の `TodoItem` / `ActionType` が並立、processor.rs に変換層
- なぜ負債か: 新しい action type 追加時に同期漏れリスク
- リスク: 高(シリアライズ形状 = ワイヤ互換性に直結)
- 可否: **提案のみ**。統合案を報告書に書くこと。実装しない

### Debt-10: Rust↔TS 契約の手動同期 【テスト追加のみ実装可】
- 根拠: `crates/log-types/src/lib.rs:23-53` の `LogEntry` を TS 側(`use-task-log-stream.ts`)が手書きミラー。codegen・契約テストなし
- なぜ負債か: 型のズレがコンパイルで検知できない
- 改善案: Rust 側でシリアライズした JSON fixture を生成し、TS 側テストが同じ fixture をパースする「契約フィクスチャテスト」を追加(ワイヤ形式は一切変えない)。**codegen(ts-rs 等)の導入は設計判断 → 提案のみ**
- 検証: 新規テストが両側で通る
- 可否: フィクスチャテスト追加のみ可

### Debt-11: Cargo ワークスペース不在・ツールチェーン不統一 【提案のみ】
- 根拠: root に Cargo.toml がなく `crates/server`, `apps/cli`, `apps/api`, `apps/desktop/src-tauri` + root に計5つの Cargo.lock。edition 2021 と 2024(executors, log-types)混在。`[workspace.lints]` なし。clippy はどこでも走っていない
- なぜ負債か: 依存バージョンのドリフト、ビルド時間、lint 不能
- リスク: 高(release CI が `--manifest-path` 前提でビルドしており、ワークスペース化は CI・配布物に波及)
- 可否: **提案のみ**。移行手順案(ワークスペース化 → lints 統一 → lock 統合)を報告書に書く。実装しない

### Debt-12: テスト不在領域 【Phase 2 で部分的に実装可】
- 根拠: server の RPC ルート(~110 エンドポイント)に統合テストなし。`task_runs.rs` 1,338行が最大かつ無テスト。worktree/git 操作・diff ストリームパイプラインも無テスト。e2e は smoke 1本
- 改善案: 触る予定の箇所に限定して安全網を追加: (a) task_runs の主要ハッピーパス(axum Router を直接叩く形)、(b) Debt-02 対象フックの特性テスト。全面的なテスト追加はスコープ外
- 可否: 上記限定で可

### Debt-13: Tailwind バージョン分裂 【提案のみ・要質問】
- 根拠: `packages/ui` = tailwindcss 4.1.11、`apps/desktop` = 3.4.1。desktop の `tailwind.config.ts:6` が ui の config を preset として import
- リスク: 高(全画面の視覚回帰)。視覚回帰テストが存在しない
- 可否: **提案のみ**(実装前に確認すべき質問に含む)

### Debt-14: apps/mobile プレースホルダ 【要質問】
- 根拠: `src/native/` に2ファイルのみ、UI 実装なし。一方 `turbo test` には jest + cargo test として接続済み(数少ない test 接続先)
- 可否: 製品判断。**触らない**(質問へ)

---

## Implementation Phases

各 Phase の終わりに必ず: 検証コマンド実行 → 結果記録 → 小さくコミット(1関心事=1コミット)。前 Phase が緑でない限り次へ進まない。

### Phase 0: 現状確認(変更なし)
1. `git status` — クリーンでなければ報告して停止
2. Baseline Commands を全て実行し、結果(成功/失敗/警告数/テスト数)を記録
3. 失敗があればその時点で報告(Stop And Ask 条件8)

### Phase 1: 検証パイプラインの修復(Debt-01)
1. `apps/desktop` に vitest 設定と `"test": "vitest run"` を追加
2. 38テストファイルが実行されることを確認。落ちるテストは**修正せず**報告
3. `bun run test` 経由(turbo)で実行されることを確認
- 検証: `bun run test` / `cd apps/desktop && bunx vitest run`

### Phase 2: 安全網の追加(Debt-12, Debt-10 の一部)
1. Debt-02 で触るフックの特性テスト: patch 適用順序、dedupe、再接続時の状態
2. `LogEntry` の契約フィクスチャテスト(Rust 側で JSON 生成 → TS 側でパース検証)。ワイヤ形式変更は禁止
3. (余力があれば) `task_runs` 主要ハッピーパスの Rust 統合テスト
- 検証: 新規テストが両側で通る。既存テストに影響なし

### Phase 3: 明らかに安全な整理(Debt-06, Debt-07, Debt-02 の一部)
1. `httpToWs` の一本化
2. `electron.d.ts` リネーム + Electron/xterm 残骸コメント修正 + i18n 文言修正(en/ja 同時)
3. 検証済み未使用依存の削除(1依存=1コミット、削除前に grep 再実行)
4. `turbo.json` の未消費 env 削除
- 検証: lint / typecheck / test / `build:vite`

### Phase 4: 小さな責務分離(Debt-04, Debt-03 の前半)
1. `prompt-editor-store.ts` から DOM パース純粋関数を抽出(既存テストを安全網に)
2. `conversation-view.tsx` から純粋関数(thinking 集約・メッセージ整形)をユーティリティ抽出 + テスト
3. `settings-panel.tsx` をセクション単位の子コンポーネントへファイル分割(props 形状不変)
- 注意: コンポーネントを render 内で定義しない(無限ループ既往歴)。motion コンポーネントと Radix asChild の組み合わせを変更しない
- 検証: vitest + 手動(セッション実行・停止、設定画面、@ メンション)

### Phase 5: 境界の明確化(Debt-05, Debt-02 の本体)
1. RPC クライアント共通ヘルパー統合(11 clients のボイラープレート削減、公開関数のシグネチャ不変)
2. ストリームフックを1つずつ `use-json-patch-ws-stream` 基盤へ統合。1フック=1コミット、各回で手動ストリーム確認
- 検証: Phase 2 の特性テスト + 手動: タスク実行中のライブログ、ネットワーク切断→再接続

### Phase 6: テスト追加を伴う store 分割(Debt-04 の後半)
1. `files-store.ts` の現挙動テストを作成
2. 緑になってから Tree / Operations 分割を実施(公開セレクタ・アクション名は維持)
- 検証: 新規テスト + 手動ファイル操作一式

### Phase 7: 提案書の作成(実装しない)
以下を `docs/YYYYMMDD_refactor-proposals.md` にまとめる(日時は `date` コマンドで確認):
- Cargo ワークスペース化 + `[workspace.lints]` + clippy 導入手順(Debt-11)
- ワイヤ型 codegen(ts-rs 等)の比較検討(Debt-10)
- ClaudeTodoItem/TodoItem 統合案(Debt-09)
- Tailwind 4 統一の移行計画(Debt-13)
- CI への `cargo test` / `bun test` ゲート追加案(check.yml の変更はユーザー承認後)
- `conversation-view` / `single-agent-session` の本格分割設計

---

## Verification Requirements

- 各 Phase 終了時に最低限: `bun run lint && bun run typecheck && bun run test` + 触った Rust クレートの `cargo test --manifest-path crates/<crate>/Cargo.toml`
- フロントの挙動変更リスクがある Phase(4,5,6)では `bun run --filter=@chro/desktop dev:web` で起動し、対象フローを手動確認(タスク実行・ライブログ・ファイル操作・設定画面)
- baseline との差分で判断する: baseline で既に失敗していたものは自分の責任範囲外として報告のみ
- 新規テストは決定的であること(ネットワーク・実時間依存禁止、tempfile/fixture 使用)

## Reporting Format

各 Phase ごとに以下を報告する:

```
## Phase N: <name>
- 変更ファイル: <list>
- コミット: <hash> <message>
- 実行した検証コマンドと結果:
  - <command> → PASS/FAIL (テスト数, 所要時間)
- baseline からの差分: <新規テスト+N、警告 -M など>
- 発見事項・質問: <あれば。Stop And Ask 該当時はここで停止>
```

最終報告には、実行した全コマンドとその最終結果、未着手の項目、Phase 7 の提案書へのリンクを含める。

## Out-of-scope Items

- SQLite WAL 化(禁止)
- React / Tailwind / Tauri / sqlx 等のバージョンアップ
- 新機能、UI デザイン変更、文言の意味変更(Electron 誤記の修正を除く)
- `apps/api` の機能変更(認証・waitlist・invite)
- `apps/mobile` 全般
- release 系 GitHub workflows の変更
- ワイヤフォーマット・RPC パスの変更
- codegen / バリデーションライブラリ / Cargo ワークスペースの導入(提案のみ)
- ターミナル機能の拡張(IME・スクロールバック検索等)
