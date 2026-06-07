# Changelog

## 0.1.35

- Fixed Claude Code and Codex being detected as "not installed" on Windows when their CLI was installed under a Node version manager (fnm, nvm-windows, Volta) or an npm global prefix whose directory is only added to `PATH` by the PowerShell profile, by reading `PATH` from the user's dot-sourced PowerShell `$PROFILE` (pwsh and Windows PowerShell) during CLI discovery
- Unified Claude/Codex discovery onto the single layered resolver so install detection, version probing, MCP status, and execution all resolve the binary the same way, removing the duplicated per-tool location lists

## 0.1.34

- Fixed the Windows desktop app failing to start its `chro-server` sidecar with a "VCRUNTIME140.dll was not found" error on machines without the Visual C++ Redistributable, by statically linking the C runtime into the sidecar binary

## 0.1.33

- Added structured task/session context references, storing prompt references in `task_context_refs`, exposing context refs and referenced-by RPC/CLI surfaces, and preserving `<context>` prompt tags for executor compatibility
- Added a desktop `Refs` popover in the session header that shows outgoing session references and incoming "referenced by" relationships, with linked task/session rows
- Added CLI support for attaching referenced sessions to new tasks and follow-ups, plus `chro task refs` and `chro task referenced-by` for inspecting the reference graph
- Fixed the file tree scope for session tabs whose route key is a task slug by resolving it to the task UUID before subscribing to task runs
- Fixed project switching from killing live terminal PTY sessions by only recycling terminals that were opened before their project UUID resolved
- Fixed release checks by applying Rust formatting and aligning shared React/TypeScript dependency versions across workspaces
- Documented the Remote SSH/app-server architecture for future VS Code-style remote workspace support

## 0.1.32

- Migrated the desktop app from Electron to Tauri 2, so it now ships as a native Rust shell running on the system WebView instead of a bundled Chromium + Node runtime; auto-update, the dynamic tray badge, the `chro://` deep-link handler, and the custom asset protocol were reimplemented natively while the React renderer stays behind a compatibility shim
- Added a right-side dock that can hold Files, Search, and Source Control independently of the left dock, with the toggle chrome living in the project tabs header
- Added a Projects panel listing each project's chats with inline archive, new-chat, drag-to-reorder, and "open another project" actions
- Added an Obsidian-style in-file find bar for Cmd+F, with previous/next navigation and live match highlighting across file content, titles, and frontmatter
- Replaced the global command-palette search overlay with a dockable Search panel and a dedicated search shortcut, so file search results live alongside the other workspace panels
- Rebuilt conversation history with an incremental flatten cache that reuses array references and only rebuilds the slices whose entries actually changed, making session rendering and live streaming smoother
- Reworked agent CLI discovery with a layered resolver that honors an environment override, probes known install locations in order, and refreshes PATH from a login shell, so apps launched from Finder reliably find Claude/Codex binaries installed via Homebrew or NVM
- Fixed release packaging for the Tauri desktop app, including the update manifest repository, updater signing artifacts, Windows installer output, bundled CLI web frontend build, and removal of the unused Argos workflow from OSS sync

## 0.1.31

- Unified the desktop userData directory with the Rust server's default DB path so the desktop app and `chro` CLI now share a single SQLite database, with chained migrations that flatten earlier `Chronist/` → `Chro/chronist/` → `Chro/chro/` layouts down to `<appData>/chro/`
- Made project switching (header tabs and project switcher dropdown) navigate to the project's persisted focused tab instead of overwriting the saved layout with a stray "new session" tab on every reopen
- Introduced a shared `path_resolve` helper and reworked file/filesystem/task-run RPC endpoints to normalize absolute paths against project and task-run worktree roots, so URLs and docs pasted or emitted by agents now open correctly
- Added a split-drop preview overlay while dragging a tab so the target split region is highlighted before the drop
- Removed the unintended inner rounded corners on the prompt editor's text area
- Fixed `chro task logs` (and `GET /rpc/tasks/{id}/transcript`) showing only the user prompt by parsing each stdout entry as an independent stream-json line instead of concatenating chunks into a single newline-keyed buffer

## 0.1.30

- Added a project tab header that switches the entire workspace (file tree, sessions, tab layout) per project, with close-on-hover, a "+" dropdown for opening additional projects, and auto-generated color avatars
- Added in-editor HTML preview for `.html`/`.htm` files with a Preview/Raw toggle, manual reload, and path-based asset endpoints so relative `<link>`/`<script>`/`<img>` references resolve to sibling files in the workspace, project, or task-run worktree
- Kept terminal PTY sessions alive across project tab switches so returning to a project restores its running shells instead of starting fresh
- Rendered Markdown table header rows in bold and made cell clicks place the cursor at the click position instead of selecting the whole cell
- Applied the correct workspace window bounds immediately after opening a workspace (no longer inheriting the onboarding window size) and raised the workspace-mode minimum width from 840px to 1100px
- Focused the existing window when reopening an already-open workspace and recycled the onboarding window into the workspace window to avoid stray empty windows
- Fixed assistant output disappearing when Claude returned unrecognized content block types (e.g. `server_tool_use`) by adding an `Unknown` fallback variant so the rest of the message still deserializes

## 0.1.29

- Reworked the desktop workspace into a tabbed pane layout with draggable tabs, split panes, per-project layout persistence, and a resizable/collapsible left dock for Files, Sessions, Search, and Source Control
- Added an integrated terminal tab backed by PTY WebSocket sessions, including xterm rendering, resize/input handling, restart support, and server-side cleanup on shutdown
- Added skill selection in the prompt editor: type `/` to discover workspace/user `SKILL.md` files, attach skills to prompts, and materialize selected skill instructions for task runs and follow-ups
- Added multi-root file browsing with "Add Folder to Project", persisted extra roots, arbitrary workspace file/binary reads, and task-run scoped file tabs for opening files from an agent worktree
- Updated task CLI and server endpoints to use task IDs/slugs by default, add `--run N` selection for cancel/diff/merge/rebase, and make `chro task logs` print the task transcript
- Improved session UX with URL/tab sync, running-session badges, file drag-to-prompt context attachments, raw Codex reasoning stream rendering, and broader session/context tests

## 0.1.28

- Updated the Codex executor to `@openai/codex@0.125.0` and migrated it to the new thread/turn app-server protocol
- Suppressed noisy Claude `System: status` protocol messages from conversation logs
- Added Playwright and Argos visual smoke tests for the desktop app

## 0.1.27

- Added target branch to `chro task status` output

## 0.1.26

- Added `chro task rebase` command to rebase a task run branch onto a new base (defaults to the run's target branch)
- Added Chro CLI skill for AI agent integration (`skills/chro/`)

## 0.1.25

- Fixed desktop app "Failed to fetch" error when executing tasks by adding `x-perf-request-id` to CORS allowed headers
- Fixed desktop app unintentionally opening a browser window on startup by adding `--no-open` server flag

## 0.1.24

- Added "Skip for now" option to onboarding provider selection, allowing users to enter the workspace without configuring an agent
- Added auth polling cleanup with timeout to prevent leaked intervals on the onboarding screen
- Fixed onboarding screen redirecting to workspace prematurely when a saved executor exists but auth has not been skipped
- Fixed Rust code formatting in CLI module (`cargo fmt`)

## 0.1.23

- Added CLI task management commands (`chro task list`, `create`, `run`, `logs`, `cancel`, `diff`, `merge`)
- Added CLI client module for communicating with the local Chro server via HTTP
- Added `--project` flag to CLI for specifying a git repository path
- Fixed executor selection not persisting immediately in settings panel
- Removed redundant `updateExecutorProfile` call from auth login flow

## 0.1.22

- Unified versioning across Desktop and CLI into a single product version
- Added CHANGELOG gate to release process: releases require a changelog entry before tagging
- Release notes are now automatically extracted from CHANGELOG.md and used as Git tag annotations and GitHub Release body
- Changed CLI release workflow from manual dispatch to tag-triggered, firing alongside Desktop on the same `v*` tag
- Added timestamp-tag filter to prevent legacy CLI tags from triggering Desktop builds
