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

Chro는 코딩 에이전트를 병렬로 실행하고, 그 결과물의 가치를 판단하는 워크스페이스입니다. 원하는 결과를 설명하면 에이전트가 격리된 Git worktree에서 작업을 수행하고, 변경 내용은 실시간 diff로 돌아옵니다. 승인하기 전에는 어떤 변경도 내 브랜치에 닿지 않습니다.

이미 가지고 있는 에이전트 구독(**Claude Code**, **Codex**)으로 바로 동작하며, 메모, 저장소, 히스토리까지 모든 것이 내 머신에 남습니다.

## 설계 원칙

Chro에는 뚜렷한 관점이 있습니다. 그 관점은 다음과 같습니다.

### 편집은 에이전트가, 결정은 당신이

Chro는 에디터가 아니며 IDE와 경쟁하지 않습니다. Chro에서 사람의 일은 에이전트에게 방향을 제시하고, 그 결과물을 검토하고, 에이전트가 참조할 지식을 가꾸는 것입니다. 파일을 직접 편집하는 일은 전제가 아니라 예외입니다. 아래의 모든 설계 결정은 이 역전에서 출발합니다.

### 작업의 단위는 파일이 아니라 세션

IDE가 파일 트리를 앞세우는 이유는 파일이 조작 대상이기 때문입니다. Chro에서 일차적인 대상은 실행 중인 세션이며, 화면은 왼쪽에서 오른쪽으로 *누가 → 대화 → 증거* 순으로 읽힙니다.

- **왼쪽: 누가 일하고 있는가.** 모든 프로젝트를 아우르는 세션과 에이전트 목록입니다. 가장 자주 만지는 내비게이션이므로 가장 중요한 위치를 차지합니다.
- **가운데: 대화.** 에이전트와의 대화는 부수 채널이 아니라 작업 그 자체입니다.
- **오른쪽: 증거.** 파일, 검색, Git이 하나의 검증 dock에 모여 있습니다. 작업의 출발점이 아니라, 에이전트가 무엇을 했는지 확인하기 위해 손을 뻗는 곳입니다.

### 샌드박스는 에이전트의 것, 정본 브랜치는 당신의 것

모든 에이전트는 일회용 worktree에서 실행되므로, 아무리 많은 에이전트가 동시에 일해도 내 브랜치는 건드려지지 않습니다. 이 구분은 실행상의 세부 사항일 뿐이며, 사용자의 멘탈 모델로 새어 나와서는 안 됩니다.

- **샌드박스에는 검토하러 들어갑니다.** 주로 diff와 커밋을 통해서이며, 대부분 읽기 위주의 화면입니다.
- **직접 작성하는 모든 것은 정본 쪽에 남습니다.** 메모, 문서, 구조화된 뷰(`.cbase`), 다이어그램이 그렇습니다. 메모 하나를 쓰기 위해 어느 worktree에 속할지 고민할 필요가 없어야 합니다.

### 지식은 버전 관리되는 파일

내 컨텍스트는 Git 저장소 안의 평범한 파일입니다. Markdown 메모, frontmatter, 구조화된 뷰, 다이어그램. 독점 사일로도, 내보내기 단계도 없습니다. 그래서 지식은 오래가고(코드처럼 버전 관리되고), 이동 가능하며(코드처럼 클론되고), 유용합니다(에이전트도 나와 같은 방식으로 읽습니다).

### 동의 없이는 아무것도 반영되지 않는다

에이전트는 제안하고, 결정은 당신이 합니다. 민감한 명령과 파일 작업은 승인 게이트 뒤에서 대기하고, 에이전트가 실행 중인 동안에도 diff를 볼 수 있으며, 머지는 언제나 명시적인 행위입니다. 병렬 실행이 안전한 이유는 모든 결과가 검토 전까지 격리되어 있기 때문입니다.

## 기능

- **병렬 에이전트 오케스트레이션**: 하나의 태스크에서 여러 에이전트를 실행합니다. 각 에이전트는 자체 worktree 샌드박스와 실시간 타임라인을 가집니다.
- **Worktree 격리**: 각 에이전트는 전용 Git worktree에서 실행되며, 머지 전까지 내 브랜치는 안전하게 유지됩니다.
- **로컬 퍼스트 지식**: 아이디어, 메모, 리서치는 내가 소유한 파일로 남고, 에이전트의 사고 방식을 형성합니다.
- **통합 리뷰**: 모든 에이전트의 커밋, 로그, diff를 한곳에서 확인합니다.
- **승인 게이트**: 에이전트가 민감한 명령이나 파일 작업을 수행하기 전에 명시적인 승인이 필요합니다.
- **내장 Git 워크플로**: 앱을 벗어나지 않고 diff와 PR 워크플로 전체를 진행할 수 있습니다.

## 시작하기

### 데스크톱 앱

다운로드해 설치하면 됩니다. 베타 기간에는 무료이며, Claude Code / Codex 구독으로 사용할 수 있습니다.

| 플랫폼 | 링크 |
|--------|------|
| macOS (Apple Silicon) | [.dmg 다운로드](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [.dmg 다운로드](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [.exe 다운로드](https://github.com/n-asuy/chro/releases/latest) |

### CLI (브라우저 + 로컬 서버)

데스크톱 앱 없이도 브라우저에서 Chro를 실행할 수 있습니다. 작업 관리 명령도 함께 제공합니다.

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

Chro를 실행하고 아무 Git 저장소나 워크스페이스로 엽니다. 로컬 파일이 곧바로 에이전트가 활용하는 지식 컨텍스트가 됩니다.

### 2. 태스크 생성

새 세션을 시작하고 원하는 내용을 설명합니다. 기능 추가, 버그 수정, 리팩토링 무엇이든 좋습니다. 추가 맥락이 필요하면 메모나 파일을 함께 붙일 수 있습니다.

### 3. 에이전트 실행

태스크에 하나 이상의 에이전트를 할당합니다. 각 에이전트가 독립된 Git worktree에서 즉시 작업을 시작합니다. 타임라인에서 실시간으로 진행 상황을 확인할 수 있습니다.

### 4. 리뷰 및 머지

각 에이전트의 커밋과 diff를 하나씩 살펴봅니다. 원하는 부분만 승인하고 나머지는 버린 뒤 머지할 수 있으며, 이 모든 과정을 Chro 안에서 끝낼 수 있습니다.

## 아키텍처

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

| 레이어 | 기술 스택 |
|--------|----------|
| 데스크톱 | Electron 38 |
| 프론트엔드 | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| 콘텐츠 | Markdown 퍼스트 파일, frontmatter, CodeMirror 6 WYSIWYG, Monaco Editor |
| 데이터 | 로컬은 SQLite + SQLx, 클라우드는 D1 |
| 백엔드 | Rust, Axum 0.7, Tokio, JSON-RPC, WebSocket |
| 빌드 | Bun, Turborepo, Biome |

## 개발

**사전 요구 사항:** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # 의존성 설치
bun dev:desktop      # 전체 데스크톱 앱 시작 (Rust + Vite + Electron)
bun dev:cli          # CLI 플로 시작 (브라우저 UI + 로컬 서버)
```

```bash
bun test             # 테스트 실행
bun lint             # Biome 린트
bun typecheck        # TypeScript 타입 검사
```

## 보안 및 개인정보

Chro는 로컬 퍼스트를 전제로 설계되었습니다. 지식, 메모, 코드는 모두 사용자의 머신에 저장됩니다. 에이전트는 격리된 worktree에서 명시적인 승인과 함께 실행되며, 동의하지 않는 한 메인 브랜치에는 어떤 변경도 반영되지 않습니다. Anthropic과는 무관합니다. 취약점 보고 방법은 [SECURITY.md](../../SECURITY.md)를 참고하세요.

## 라이선스

자세한 내용은 [LICENSE](../../LICENSE.md)를 참고하세요.
