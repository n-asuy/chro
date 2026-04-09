<p align="center">
  <img src="../../banner.jpg" alt="Chro — 아이디어가 병렬로 움직입니다" width="100%">
</p>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../apps/desktop/assets/logo/logo_chro_invert_symbol.png">
  <source media="(prefers-color-scheme: light)" srcset="../../apps/desktop/assets/logo/logo_chro_symbol.png">
  <img alt="Chro" src="../../apps/desktop/assets/logo/logo_chro_symbol.png" width="50">
</picture>

# Chro

**아이디어가 병렬로 움직입니다.**

코딩 에이전트를 조율하는 로컬 퍼스트 AI 워크스페이스.<br/>
격리된 worktree에서 여러 에이전트를 병렬로 실행하고, 실시간 diff를 보면서 승인한 변경만 머지하세요.

[![Check](https://github.com/n-asuy/chro/actions/workflows/check.yml/badge.svg)](https://github.com/n-asuy/chro/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/License-see_LICENSE.md-blue.svg)](../../LICENSE.md)

[웹사이트](https://chro-ai.com) · [다운로드](https://github.com/n-asuy/chro/releases/latest) · [보안](../../SECURITY.md)

**[English](../../README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어 | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | [Tiếng Việt](README.vi.md) | [Deutsch](README.de.md)**

</div>

## Chro란?

Chro는 메모, 리서치, 프로젝트 맥락을 바탕으로 AI 에이전트를 병렬로 실행할 수 있게 해줍니다. 하나의 작업 화면에서 여러 코딩 에이전트를 띄울 수 있고, 각 에이전트는 독립된 Git worktree에서 동작하므로 준비가 되기 전까지 메인 브랜치는 그대로 유지됩니다.

터미널을 오가며 컨텍스트를 바꿀 필요가 없습니다. worktree를 수동으로 관리할 필요도 없습니다. 에이전트의 로그와 diff는 통합 에디터에 실시간으로 표시되며, 명시적으로 승인하기 전에는 어떤 변경도 메인 브랜치에 반영되지 않습니다. 기존 **Claude Code** 또는 **Codex** 구독으로 바로 사용할 수 있습니다.

<p align="center">
  <img src="../../assets/demo1.png" alt="Chro 워크스페이스 1" width="49%">
  <img src="../../assets/demo2.png" alt="Chro 워크스페이스 2" width="49%">
</p>
<p align="center">
  <img src="../../assets/demo3.png" alt="Chro 워크스페이스 3" width="49%">
  <img src="../../assets/demo4.png" alt="Chro 워크스페이스 4" width="49%">
</p>

## 기능

- **병렬 에이전트 오케스트레이션** — 하나의 작업 화면에서 여러 에이전트를 실행합니다. 각 에이전트는 자체 worktree 샌드박스와 실시간 타임라인을 가집니다.
- **Worktree 격리** — 각 에이전트는 전용 Git worktree에서 실행되며, 머지 전까지 메인 브랜치는 안전하게 유지됩니다.
- **로컬 퍼스트 지식** — 아이디어, 메모, 리서치는 내가 가진 파일로 남습니다. 이 맥락이 에이전트의 사고와 생성 방식에 반영됩니다.
- **통합 에디터** — 모든 에이전트의 커밋, 로그, 에셋을 인라인 diff와 함께 한곳에서 검토합니다.
- **승인 단계** — 에이전트가 민감한 명령이나 파일 작업을 수행하기 전에 명시적인 승인이 필요합니다.
- **칸반 보드** — 포커스 모드와 피크 모드로 작업을 시각적으로 정리합니다.
- **내장 Git 워크플로** — 앱을 벗어나지 않고 diff 검토와 PR 흐름을 진행할 수 있습니다.

## 시작하기

### 데스크톱 앱

다운로드해 설치하면 됩니다. 베타 기간에는 무료이며, Claude Code / Codex 구독으로 사용할 수 있습니다.

| 플랫폼 | 링크 |
|--------|------|
| macOS (Apple Silicon) | [.dmg 다운로드](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [.dmg 다운로드](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [.exe 다운로드](https://github.com/n-asuy/chro/releases/latest) |

### CLI (브라우저 + 로컬 서버)

데스크톱 앱 없이도 브라우저와 로컬 서버로 Chro를 실행할 수 있습니다. 작업 관리 명령도 함께 제공합니다.

```bash
npx @chro-ai/cli                # Chro 시작 (브라우저 + 로컬 서버)
```

```bash
npx @chro-ai/cli task list                              # 태스크 목록
npx @chro-ai/cli task create "인증 모듈 유닛 테스트 추가"  # 태스크 생성
npx @chro-ai/cli task run <id>                          # 에이전트로 태스크 실행
npx @chro-ai/cli task logs <id>                         # 실행 로그 스트리밍
npx @chro-ai/cli task merge <id>                        # 에이전트 변경사항 머지
```

전체 명령어는 `npx @chro-ai/cli --help`를 참고하세요.

## 빠른 시작

### 1. 프로젝트 열기

Chro를 실행하고 Git 저장소를 워크스페이스로 엽니다. 로컬 파일이 곧바로 에이전트가 활용하는 작업 맥락이 됩니다.

### 2. 태스크 생성

칸반 보드에서 작업을 생성합니다. 기능 추가, 버그 수정, 리팩토링처럼 원하는 내용을 설명하고, 필요하면 메모나 파일을 함께 붙일 수 있습니다.

### 3. 에이전트 실행

태스크에 하나 이상의 에이전트를 할당합니다. 각 에이전트가 독립된 Git worktree에서 즉시 작업을 시작합니다. 타임라인에서 실시간으로 진행 상황을 확인할 수 있습니다.

### 4. 리뷰 및 머지

통합 에디터에서 각 에이전트의 커밋과 diff를 확인합니다. 원하는 변경만 승인하고 나머지는 버린 뒤 머지할 수 있으며, 이 모든 과정을 Chro 안에서 끝낼 수 있습니다.

## 아키텍처

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

| 레이어 | 기술 스택 |
|--------|----------|
| 데스크톱 | Electron 38 |
| 프론트엔드 | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| 에디터 | CodeMirror 6, Monaco Editor |
| 백엔드 (로컬) | Rust, Axum 0.7, Tokio, SQLx (SQLite) |
| 백엔드 (클라우드) | Rust → WASM, Cloudflare Workers, D1 |
| 빌드 | Bun, Turborepo, Biome |

## 개발

**사전 요구 사항:** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # 의존성 설치
bun dev:desktop      # 전체 데스크톱 앱 시작 (Rust + Vite + Electron)
```

```bash
bun test             # 테스트 실행
bun lint             # Biome 린트
bun typecheck        # TypeScript 타입 검사
```

## 보안 및 개인정보

Chro는 로컬 퍼스트를 전제로 설계되었습니다. 지식, 메모, 코드는 모두 사용자의 머신에 저장됩니다. 에이전트는 격리된 worktree에서 실행되며, 명시적으로 승인하지 않는 한 메인 브랜치에는 어떤 변경도 반영되지 않습니다. Anthropic과는 무관합니다. 취약점 보고 방법은 [SECURITY.md](../../SECURITY.md)를 참고하세요.

## 라이선스

자세한 내용은 [LICENSE](../../LICENSE.md)를 참고하세요.
