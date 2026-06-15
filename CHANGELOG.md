# Changelog

## 0.1.36

- Reworked the Claude executor to run the agent as a real interactive terminal session, observed through Claude Code hooks plus session-transcript tailing instead of the deprecated non-interactive print mode, so the agent can pause mid-run and route permission requests, plan-mode approvals, and clarifying questions to the app while conversation streaming, persistence, and replay keep working
- Added a structured question UI for agent clarifying questions: a stepped intake that shows one question at a time with single/multi-select option rows, descriptions, a free-form "Other" answer, and Back/Skip/Continue navigation, surfaced automatically whenever a run is blocked waiting for your answer
- Added an "awaiting input" state so a blocked session shows a paused indicator instead of the running spinner across the conversation, project tree, and inbox, clearing once you answer, the wait times out, or the next turn starts
- Reworked how agent working steps render: consecutive thinking, tool calls, and progress now collapse into a single timeline whose header shows the latest reasoning line or the command/file/search being run and shimmers while live, kept collapsed by default but auto-expanded when a tool is waiting for your approval
- Added per-turn model and reasoning-effort overrides so a follow-up can switch the Claude model (and Codex reasoning effort) for the next turn while keeping the runtime fixed for the session, with pickers in the agent selector and the "@" composer menu
- Showed the logo of the agent that actually ran each session (Claude or Codex) and its current model on session tabs and recent-session rows, with brand-new sessions showing no icon until they run
- Added a right-edge message navigation rail with one tick per message that expands on hover into clickable previews so you can jump back to any earlier turn, plus a hover preview that shows a session's last exchange from its row in the list
- Restructured Settings into dedicated panes that each load their data only when opened, adding Appearance, Terminal, and Notifications sections
- Added an app-wide theme selector (System/Light/Dark) in Appearance, moved out of Editor settings, with System following the OS appearance live and becoming the default for fresh installs
- Added a Terminal settings pane to configure the integrated terminal's font family, size, and line height, applied to open terminals immediately
- Added desktop notifications when a background agent run finishes (completed or failed) or is waiting for your input, with per-event toggles and suppression while the app is focused; on macOS they show the app icon and reopen the originating session when clicked
- Added a developer-only Feature Flags section in Settings that lists each flag with its key, status, description, owner, and retire-by date and supports per-installation on/off overrides with reset actions; flag resolution honors telemetry opt-out by falling back to built-in defaults with no network request, and initial flags gate the structured question UI, a canvas terminal renderer, and inline editor-gutter diffs
- Reworked the right-side dock navigation into a single animated segmented control for Files, Search, and Git, replacing the per-panel back buttons and the magnifying-glass shortcut
- Added a project Home overview shown when opening or switching to a project, with quick actions (New session, Search files, Skills) and a list of recent sessions, so switching projects now lands here instead of restoring the last open tab
- Added a Projects/Inbox switcher in the left dock, with a cross-project Inbox that lists every session across all projects by recency over a single connection, each tagged with its project and activity status
- Added a Skills browser listing the project's workspace skills alongside your global skills, searchable and filterable by scope and provider, where clicking a skill reveals or opens its folder
- Reworked the tab bar into browser-style rounded tabs that merge into the pane content, with a New tab (+) button offering New session or Terminal, and made empty panes and project Home open directly into a ready prompt composer
- Made the "Open in" header action open the workspace in your configured external app (Cursor, Zed, VS Code, cmux, a terminal, or the file manager), and made opening in cmux focus its existing workspace for the folder instead of stacking duplicates
- Replaced the bottom-corner update popup with an update pill in the top bar that stays hidden until an update is available and then offers download, restart-to-install, or retry, with auto-update on by default in release builds
- Refined the projects tree so clicking a project name opens its Home (the chevron handles expand/collapse), added connector guide lines under expanded chats, switched to filled folder icons, and moved sort selection into a checkmarked menu
- Fixed occasional load-induced UI freezes ("all sessions locked") during git status by running git as a killable subprocess with a hard timeout instead of an uncancellable in-process call that could crawl huge untracked trees for minutes, and moved every git operation off the async runtime onto a blocking pool so slow scans and push/pull no longer stall the app
- Fixed push on a freshly-created branch failing with "no upstream branch" by always publishing with `--set-upstream`, and made push and pull honor a branch's configured remote and effective upstream so forked or unpublished branches sync to the right place
- Fixed Source Control ahead/behind badges showing an error or a swapped count for never-published branches by reporting zero until the branch is published and counting against the effective upstream
- Added a Source Control panel for individual task-run sessions (status, branches, diff, stage/unstage, commit, push, pull, and discard against that session's worktree), plus an "all changes" diff view that shows everything a branch introduced against its merge-base
- Reduced server CPU usage by sharing one recursive file watcher per worktree across all subscriptions and dropping ignored paths (`.git`, `node_modules`, `target`, and gitignored files) before the debounce buffer, so heavy build and dependency churn no longer drives CPU
- Fixed sessions getting stuck on a loading spinner (and the session list flashing to "loading" on remount) by deduplicating WebSocket subscriptions behind a ref-counted, endpoint-keyed shared connection registry that reuses the live socket and keeps cached data across consumer churn
- Capped how many git operations run at once so bursts of status, diff, and branch-status polling across many sessions queue briefly instead of flooding the blocking pool
- Fixed long Markdown tables so they scroll within their own box instead of widening the whole message, with a sensible minimum cell width
- Fixed the conversation pane sometimes getting stuck on a loading spinner by ensuring history replay always resolves, with a safety timeout for wedged or half-open streams
- Fixed a crash ("Maximum update depth exceeded") from the loading shimmer, notably while a run was being cancelled, and a brief flash of the full project file tree when switching between sessions
- Refined menus, popovers, and dropdowns with softer rounded corners and lighter shadows, and added subtle fade transitions when switching dock panels and views (respecting reduced-motion preferences)

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
