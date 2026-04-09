<p align="center">
  <img src="../../banner.jpg" alt="Chro — Ý tưởng của bạn chạy song song" width="100%">
</p>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../apps/desktop/assets/logo/logo_chro_invert_symbol.png">
  <source media="(prefers-color-scheme: light)" srcset="../../apps/desktop/assets/logo/logo_chro_symbol.png">
  <img alt="Chro" src="../../apps/desktop/assets/logo/logo_chro_symbol.png" width="50">
</picture>

# Chro

**Ý tưởng của bạn chạy song song.**

Không gian làm việc AI local-first để điều phối các agent lập trình.<br/>
Khởi chạy nhiều agent song song trong các worktree tách biệt, theo dõi diff trực tiếp và chỉ merge những gì bạn phê duyệt.

[![Check](https://github.com/n-asuy/chro/actions/workflows/check.yml/badge.svg)](https://github.com/n-asuy/chro/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/License-see_LICENSE.md-blue.svg)](../../LICENSE.md)

[Website](https://chro-ai.com) · [Tải xuống](https://github.com/n-asuy/chro/releases/latest) · [Bảo mật](../../SECURITY.md)

**[English](../../README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português](README.pt-BR.md) | Tiếng Việt | [Deutsch](README.de.md)**

</div>

## Chro là gì?

Chro biến ghi chú, tài liệu nghiên cứu và bối cảnh dự án của bạn thành khả năng thực thi AI song song. Từ một màn hình tác vụ duy nhất, bạn có thể khởi chạy nhiều agent lập trình; mỗi agent chạy trong worktree Git riêng, nên nhánh chính vẫn nguyên vẹn cho đến khi bạn sẵn sàng.

Không cần liên tục chuyển ngữ cảnh giữa các terminal. Không cần tự quản lý worktree bằng tay. Các agent gửi log và diff theo thời gian thực vào một trình soạn thảo hợp nhất, và sẽ không có thay đổi nào chạm vào nhánh chính nếu chưa có sự phê duyệt rõ ràng của bạn. Hoạt động với gói đăng ký **Claude Code** hoặc **Codex** hiện có.

<p align="center">
  <img src="../../assets/demo1.png" alt="Không gian làm việc Chro 1" width="49%">
  <img src="../../assets/demo2.png" alt="Không gian làm việc Chro 2" width="49%">
</p>
<p align="center">
  <img src="../../assets/demo3.png" alt="Không gian làm việc Chro 3" width="49%">
  <img src="../../assets/demo4.png" alt="Không gian làm việc Chro 4" width="49%">
</p>

## Tính năng

- **Điều phối agent song song** — khởi chạy nhiều agent từ một màn hình tác vụ duy nhất. Mỗi agent có sandbox worktree riêng và timeline thời gian thực.
- **Cô lập bằng worktree** — mỗi agent chạy trong một worktree Git chuyên biệt, giúp nhánh chính an toàn cho đến khi merge.
- **Tri thức local-first** — ý tưởng, ghi chú và nghiên cứu của bạn vẫn nằm trong các file do bạn sở hữu. Ngữ cảnh đó định hình cách agent suy nghĩ và tạo ra kết quả.
- **Trình soạn thảo hợp nhất** — xem commit, log và tài nguyên của mọi agent tại một nơi, với diff inline.
- **Bước phê duyệt** — agent cần được bạn phê duyệt rõ ràng trước khi chạy lệnh nhạy cảm hoặc thao tác trên file.
- **Bảng Kanban** — sắp xếp công việc trực quan với chế độ tập trung và xem nhanh.
- **Quy trình Git tích hợp** — theo dõi diff và PR mà không cần rời ứng dụng.

## Bắt đầu

### Ứng dụng Desktop

Tải và cài đặt ứng dụng. Miễn phí trong giai đoạn beta và hoạt động với đăng ký Claude Code / Codex.

| Nền tảng | Liên kết |
|----------|----------|
| macOS (Apple Silicon) | [Tải .dmg](https://github.com/n-asuy/chro/releases/latest) |
| macOS (Intel) | [Tải .dmg](https://github.com/n-asuy/chro/releases/latest) |
| Windows | [Tải .exe](https://github.com/n-asuy/chro/releases/latest) |

### CLI (Trình duyệt + Server cục bộ)

Chạy Chro trên trình duyệt mà không cần ứng dụng desktop. Bạn cũng có sẵn các lệnh để quản lý tác vụ.

```bash
npx @chro-ai/cli                # Khởi động Chro (trình duyệt + server cục bộ)
```

```bash
npx @chro-ai/cli task list                              # Danh sách tác vụ
npx @chro-ai/cli task create "Thêm unit test cho auth"  # Tạo tác vụ
npx @chro-ai/cli task run <id>                          # Chạy agent trên tác vụ
npx @chro-ai/cli task logs <id>                         # Xem log thực thi
npx @chro-ai/cli task merge <id>                        # Merge thay đổi của agent
```

Chạy `npx @chro-ai/cli --help` để xem tham chiếu đầy đủ các lệnh.

## Bắt đầu nhanh

### 1. Mở dự án

Khởi chạy Chro và mở bất kỳ kho Git nào làm workspace. Các file cục bộ sẽ trở thành ngữ cảnh mà agent dùng để làm việc.

### 2. Tạo tác vụ

Sử dụng bảng Kanban để tạo tác vụ. Mô tả điều bạn muốn thực hiện: tính năng mới, sửa lỗi hay tái cấu trúc. Nếu cần, bạn có thể đính kèm ghi chú hoặc file làm ngữ cảnh.

### 3. Khởi chạy agent

Gán một hoặc nhiều agent cho tác vụ. Mỗi agent bắt đầu ngay lập tức trong worktree Git riêng. Theo dõi tiến độ thời gian thực qua timeline.

### 4. Xem xét và merge

Duyệt qua commit và diff của từng agent trong trình soạn thảo hợp nhất. Giữ lại phần bạn muốn, bỏ phần còn lại rồi merge, tất cả đều diễn ra ngay trong Chro.

## Kiến trúc

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

| Lớp | Stack |
|-----|-------|
| Desktop | Electron 38 |
| Frontend | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| Editor | CodeMirror 6, Monaco Editor |
| Backend (cục bộ) | Rust, Axum 0.7, Tokio, SQLx (SQLite) |
| Backend (đám mây) | Rust → WASM, Cloudflare Workers, D1 |
| Build | Bun, Turborepo, Biome |

## Phát triển

**Yêu cầu:** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # Cài đặt dependencies
bun dev:desktop      # Khởi động ứng dụng desktop đầy đủ (Rust + Vite + Electron)
```

```bash
bun test             # Chạy test
bun lint             # Lint với Biome
bun typecheck        # Kiểm tra kiểu TypeScript
```

## Bảo mật và quyền riêng tư

Chro được thiết kế theo hướng local-first. Kiến thức, ghi chú và mã nguồn của bạn được lưu trên chính máy của bạn. Agent chạy trong các worktree cô lập, và sẽ không có thay đổi nào vào nhánh chính nếu chưa có sự đồng ý rõ ràng của bạn. Chro không liên kết với Anthropic. Xem [SECURITY.md](../../SECURITY.md) để báo cáo lỗ hổng.

## Giấy phép

Xem [LICENSE](../../LICENSE.md) để biết chi tiết.
