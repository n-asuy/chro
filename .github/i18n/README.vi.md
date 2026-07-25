<p align="center">
  <img src="../../banner.jpg" alt="Chro: Nạp tri thức của bạn, sáng tạo song song" width="100%">
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

Chro là không gian làm việc để chạy các agent lập trình song song và quyết định xem thành quả của chúng đáng giá đến đâu. Bạn mô tả kết quả mình muốn, các agent thực thi trong những worktree Git tách biệt, và các thay đổi của chúng được truyền về dưới dạng diff trực tiếp. Không có gì chạm đến nhánh của bạn cho đến khi bạn phê duyệt.

Chro hoạt động với các gói đăng ký agent bạn đang có sẵn (**Claude Code**, **Codex**) và giữ mọi thứ trên máy của bạn: ghi chú, kho mã nguồn và lịch sử làm việc.

## Nguyên tắc thiết kế

Chro có chính kiến rõ ràng. Đây là những chính kiến đó.

### Agent chỉnh sửa, bạn quyết định

Chro không phải là một trình soạn thảo và không cạnh tranh với IDE của bạn. Trong Chro, công việc của con người là điều hướng agent, xem xét những gì chúng tạo ra, và chăm chút nguồn tri thức mà chúng dựa vào. Tự tay chỉnh sửa file là ngoại lệ, không phải tiền đề. Mọi quyết định thiết kế bên dưới đều bắt nguồn từ sự đảo ngược này.

### Đơn vị công việc là session, không phải file

Một IDE đặt cây file lên hàng đầu vì file là thứ bạn thao tác. Trong Chro, đối tượng chính là session đang chạy, nên màn hình được đọc từ trái sang phải theo trình tự *ai → đối thoại → bằng chứng*:

- **Bên trái: ai đang làm việc.** Các session và agent trên mọi dự án. Đây là phần điều hướng bạn chạm vào nhiều nhất, nên nó chiếm vị trí chính.
- **Ở giữa: cuộc đối thoại.** Cuộc trò chuyện với agent chính là công việc, không phải một kênh phụ.
- **Bên phải: bằng chứng.** File, tìm kiếm và Git nằm chung trong một khoang kiểm chứng. Bạn tìm đến chúng để xác minh những gì agent đã làm, chứ không phải làm điểm khởi đầu của công việc.

### Sandbox thuộc về agent, nhánh chính thức thuộc về bạn

Mỗi agent chạy trong một worktree dùng xong có thể vứt bỏ, nên nhánh của bạn vẫn nguyên vẹn trong khi bao nhiêu agent làm việc cùng lúc cũng được. Sự phân tách đó là chi tiết thực thi, và nó không được phép rò rỉ vào mô hình tư duy của bạn:

- **Bạn bước vào sandbox để xem xét**, chủ yếu thông qua diff và commit. Đó là bề mặt chủ yếu để đọc.
- **Bất cứ thứ gì bạn tự tay viết ra đều nằm ở phía chính thức**: ghi chú, tài liệu, các view có cấu trúc (`.cbase`), sơ đồ. Việc viết một ghi chú không bao giờ nên đòi hỏi bạn phải quyết định nó thuộc về worktree nào.

### Tri thức là các file được quản lý phiên bản

Ngữ cảnh của bạn là những file thuần túy trong một kho Git: ghi chú Markdown, frontmatter, các view có cấu trúc, sơ đồ. Không có silo độc quyền, không có bước export. Chính điều này làm cho tri thức trở nên bền vững (được quản lý phiên bản như code), khả chuyển (được clone như code) và hữu ích (agent đọc nó theo đúng cách bạn đọc).

### Không gì được hợp nhất khi chưa có sự đồng ý

Agent đề xuất, bạn định đoạt. Các lệnh nhạy cảm và thao tác trên file phải chờ sau cổng phê duyệt, diff hiển thị ngay cả khi agent còn đang chạy, và merge luôn là một hành động chủ động rõ ràng. Sự song song chỉ an toàn vì mọi kết quả đều được cách ly cho đến khi được xem xét.

## Tính năng

- **Điều phối agent song song**: khởi chạy nhiều agent từ một tác vụ duy nhất. Mỗi agent có sandbox worktree riêng và timeline thời gian thực.
- **Cô lập bằng worktree**: mỗi agent chạy trong một worktree Git chuyên biệt, giúp nhánh của bạn an toàn cho đến khi merge.
- **Tri thức local-first**: ý tưởng, ghi chú và nghiên cứu của bạn vẫn nằm trong các file do bạn sở hữu, và định hình cách agent suy nghĩ.
- **Xem xét hợp nhất**: commit, log và diff của mọi agent tại một nơi.
- **Cổng phê duyệt**: agent cần được phê duyệt rõ ràng trước khi chạy lệnh nhạy cảm hoặc thao tác trên file.
- **Quy trình Git tích hợp**: quy trình diff và PR đầy đủ mà không cần rời ứng dụng.

## Bắt đầu

### Ứng dụng Desktop

Tải và cài đặt. Miễn phí trong giai đoạn beta. Hoạt động với đăng ký Claude Code / Codex của bạn.

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

Khởi chạy Chro và mở bất kỳ kho Git nào làm workspace. Các file cục bộ sẽ trở thành ngữ cảnh tri thức cho agent.

### 2. Tạo tác vụ

Bắt đầu một session mới và mô tả điều bạn muốn: tính năng mới, sửa lỗi hay tái cấu trúc. Đính kèm ghi chú hoặc file để bổ sung ngữ cảnh.

### 3. Khởi chạy agent

Gán một hoặc nhiều agent cho tác vụ. Mỗi agent khởi động trong worktree Git riêng và bắt đầu làm việc ngay lập tức. Theo dõi tiến độ thời gian thực qua timeline.

### 4. Xem xét và merge

Duyệt qua commit và diff của từng agent. Phê duyệt phần bạn muốn, bỏ phần còn lại rồi merge, tất cả đều diễn ra ngay trong Chro.

## Kiến trúc

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

| Lớp | Stack |
|-----|-------|
| Desktop | Electron 38 |
| Frontend | React 19, TanStack Router, Vite 7, Tailwind CSS, Zustand |
| Nội dung | File Markdown-first, frontmatter, CodeMirror 6 WYSIWYG, Monaco Editor |
| Dữ liệu | SQLite + SQLx cục bộ, D1 trên đám mây |
| Backend | Rust, Axum 0.7, Tokio, JSON-RPC, WebSocket |
| Build | Bun, Turborepo, Biome |

## Phát triển

**Yêu cầu:** [Bun](https://bun.sh) v1.1+, [Rust](https://rustup.rs), [Git](https://git-scm.com)

```bash
bun install          # Cài đặt dependencies
bun dev:desktop      # Khởi động ứng dụng desktop đầy đủ (Rust + Vite + Electron)
bun dev:cli          # Khởi động luồng CLI (UI trình duyệt + server cục bộ)
```

```bash
bun test             # Chạy test
bun lint             # Lint với Biome
bun typecheck        # Kiểm tra kiểu TypeScript
```

## Bảo mật và quyền riêng tư

Chro được thiết kế theo hướng local-first. Tri thức, ghi chú và mã nguồn của bạn được lưu trên chính máy của bạn. Agent chạy trong các worktree cô lập với cơ chế phê duyệt rõ ràng, và sẽ không có thay đổi nào vào nhánh chính nếu chưa có sự đồng ý của bạn. Chro không liên kết với Anthropic. Xem [SECURITY.md](../../SECURITY.md) để báo cáo lỗ hổng.

## Giấy phép

Xem [LICENSE](../../LICENSE.md) để biết chi tiết.
