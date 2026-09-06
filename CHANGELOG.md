# Changelog

## 0.1.51

- Fixed Codex sessions failing to start against a current Codex CLI, with the run ending on a request error before the agent had said anything. Chro built its `thread/start`, `thread/fork` and `turn/start` requests from a pinned copy of the Codex protocol, which wrote out every field that copy knew about, including the ones chro never sets, as explicit nulls; a CLI that has since retired one of those fields rejects the request for carrying the key at all. Chro now spells out the fields it actually chooses and sends nothing else, and a reasoning level it has not heard of (`max` and `ultra` arrived with GPT-6) is kept as the server reported it instead of failing the response that carries the new session's id
- Added GPT-6 Astra to the Codex model picker, listed first as the Codex catalog orders it, with the descriptions of the GPT-5.6 models refreshed to match. It needs Codex CLI 0.153.0 or newer

## 0.1.50

- Fixed Windows releases failing to build, which left 0.1.49 with no Windows installer at all. The build-time signing added in 0.1.49 pointed Tauri at the signing script by a path relative to the desktop package, but Tauri runs the hook from its own `src-tauri` directory, so the script was never found and the build stopped with only "failed to run pwsh" to show for it. The path is corrected, and the hook now keeps a log that the build prints when signing fails, so the next problem is readable instead of silent. This is the first release whose Windows installer and every binary inside it carry a signature
- Changed GitHub Release notes to come from the matching section of CHANGELOG.md. The tag annotation that used to carry them is discarded when the tag is recreated on the public repository, so every release page had shown only the commit message

## 0.1.49

- Changed the composer back to Cmd/Ctrl+Return to send, with a bare Return inserting a newline, reversing the send-on-Return switch made in the previous release. The composer holds multi-line prompts, so Return has to stay a newline the way every other multi-line field in the app treats it; both modifiers are accepted rather than branching on the platform, and the Return that confirms an IME conversion still never sends
- Added selecting several entries at once in the Files tree: Shift extends the selection to a range, Alt/Option toggles individual entries, and Cmd/Ctrl stays reserved for opening a file elsewhere. Right-clicking inside a selection acts on all of it, deleting asks once for the whole set, and Rename and Duplicate appear only when a single entry is selected
- Added moving files and folders: "Move to…" opens a searchable list of every folder in the project, including its root and never a destination inside the selection itself, and dragging a selection onto a folder moves all of it. A folder hovered during a drag opens after a moment, so a nested destination can be reached without dropping first
- Added opening the files an agent mentions: a path written in a reply, in a code span, or as a tool call's summary line becomes a link only when it resolves to something that exists (checked for a whole message in one request, against the run's worktree and its project), and clicking it opens that file as a tab, at the referenced line where one is given. Bare web addresses become links that open in the system browser, decided by the address's last label so that `README.md` and `main.rs` stay plain text. Single line breaks in agent replies now render as line breaks instead of being joined into one paragraph
- Added reading a session's earlier turns from the sidebar: the hover preview now carries a rail listing the task's turns, and pointing at one shows that turn's prompt and reply, so a past exchange can be read without opening the session
- Fixed the composer keeping its Stop button after a run had already finished, until the app was reloaded. The database change stream read each touched row back on a second connection while the writing transaction was still open, so it could publish a finished run's earlier `running` state as the last word ever sent about it. Changes are now collected per transaction and published after it commits, in commit order
- Fixed a conversation opening with its prompts visible but every reply missing, and history that failed to arrive being recorded as genuinely empty. A replay now announces itself as soon as the stream opens and ends with an explicit completion marker, so a slow replay is no longer mistaken for a dead one; an interrupted replay retries on its own and then offers "Couldn't load conversation history" with a Retry, instead of standing in for the run's real history
- Fixed a session that continues an earlier one starting a second branch and stranding everything the earlier sessions had committed: a later session now works on the branch its task already has
- Fixed a session whose worktree had lost its `.git` (what an interrupted cleanup leaves behind) failing every diff, commit and rebase with "could not find repository". Such a checkout is now rebuilt from the run's own branch instead of being resumed in place, and a worktree git could not fully delete is pruned so its branch can be checked out again rather than staying reserved forever
- Added refusing a rebase whose only effect would be to discard where a session started: a session continuing an earlier one that has no commits of its own now explains that, instead of silently replacing its starting point with the base branch
- Added a color per project: pick one from the sidebar and a dot appears beside the project's name; projects without an explicitly chosen color stay undecorated
- Reworked how file names are resolved and ranked, so the file tree, search, chat wikilinks and editor links all agree on what a file is called and which one a name refers to. Ranking is now by kind of match first (the file's own name, then an alias from its frontmatter, then a parent folder, then the rest of the path; exact before prefix before substring before fuzzy), refined by how early and how tightly the query matches, with ties broken by how recently git touched the file. Matching is case- and NFC-insensitive throughout, so a name stored decomposed by macOS matches the same name typed normally
- Changed which files are listed without their extension: only the formats chro renders as documents (`.md`, `.markdown`, `.excalidraw`, `.cbase`) hide it, so `main.rs` and `main.ts` no longer both appear as `main`
- Fixed a large HTML file losing its preview: the safe mode that strips decorations from very large documents also suppressed the preview and its Preview/Raw toolbar, even though the preview renders in a frame rather than in the editor and costs it nothing. The preview stays available at any size, and the safe-mode notice appears only while the degraded text view is actually on screen
- Fixed the frontmatter panel offering an editor for properties it cannot represent: a nested map, or a list holding structure, is now shown read-only instead of being flattened when the document is saved
- Fixed clicking a session in the sidebar doing nothing when the address bar already pointed at it, which happened as soon as a URL outlived the tab it described: after closing a session's last tab, or from a diff or browser tab, which carry no address of their own
- Replaced the Developer feature-flag list with a Beta features section in Settings. It lists only features actually offered to this installation, and only those with user-facing copy, so work still being built stays invisible; each one can be turned off on this machine
- Changed Windows releases to sign every binary in the bundle at build time rather than only the finished installer, so the installed app clears Smart App Control when it launches and not just while it installs
- Added `chro cloud` for running chro on a machine managed by a control plane: `login`, `up`, `down`, `status` and `destroy` create, reach, pause and remove the instance that the ordinary `chro task` commands then talk to. Which control plane is entirely the operator's choice. Health and quiesce are answered by a separate small process, so a wedged server can still be inspected and stopped safely
- Changed usage analytics to upload only the events on an explicit allowlist, so instrumentation added anywhere in the app stays local unless it is deliberately listed (file paths were already reduced to their extension before leaving the machine). Development builds record the full local activity stream to a file on disk, which is never uploaded
- Added Claude Fable 5.1 to the model picker, replacing Fable 5. It needs Claude Code 2.1.251 or newer: an older CLI refuses the model with an error that says so and tells you to run `claude update`

## 0.1.48

- Changed the composer to send on Return: Shift+Return and Alt+Return insert a newline, and Cmd/Ctrl+Return still sends, instead of Return always inserting a newline and only Cmd/Ctrl+Return sending. The Return that confirms an IME conversion is left to the IME and no longer sends a half-converted prompt
- Fixed a session showing as finished while its agent kept working, which several separate faults could each cause: the periodic maintenance pass marked every run recorded as running as failed, so a live run was declared dead every cycle; a second server started against the same database did the same before it had any idea what the first one was running; an older run finishing cleared the newer run's spinner and Stop button; and the conversation closed its live log connection as soon as the database said the run had ended, so nothing new appeared until the page was reopened. Runs now end only on their own process or log stream, a second server refuses to open a database another one owns, and a finishing run only clears the session it actually owns
- Fixed headless runs finishing early when the agent started a background job and ended its turn to wait for it: the CLI reported the turn as a success and killed the job on exit, so the session looked complete mid-task and resumed from scratch when prodded. Background tasks are now disabled for the runs chro drives, so long commands are awaited in the turn that started them
- Fixed a resumed session opening with a raw `error_during_execution` blob: the CLI replays the notifications of background tasks left by a previous process, and that replay's completion was taken as the answer to the newly submitted prompt, killing the CLI mid-turn. A run now ends on the reply to its own prompt
- Added approving MCP tool calls requested by Codex from inside the conversation: the request appears as a card naming the tool and its server, showing the arguments it would run with and whether it would run outside the sandbox, and answers with Allow, Allow for this session, Always allow, or Deny
- Fixed Merge reporting a repository error on a branch whose work has already reached the base by another route (the state a rebase and pull leaves behind): it now says there is nothing left to merge. Merge and rebase failures in Source Control are also reported as a readable message instead of the button silently stopping, and branch status is refreshed so the buttons reflect the state the failure left behind
- Fixed SVG and MathML content rendering as empty boxes in documents: sanitization dropped their entire element and attribute vocabulary, and the style reset applied to embedded HTML stripped the presentation attributes that give shapes their fill and size. Diagrams and formulas now render, and diagrams scale down to the content column instead of overflowing it
- Changed links inside the HTML preview to act on the app instead of navigating the preview frame: a link to a workspace file opens that file as an editor tab, and a web address opens in the system browser, rather than replacing the preview with another file's raw bytes and leaving no way back but a refresh
- Changed the media gallery of a session worktree to open as a center tab, the same as the project-level gallery, instead of replacing the Files panel with a grid; the panel keeps listing files while the gallery is open

## 0.1.47

- Added approving agent requests from the terminal: `chro approval list` shows what is waiting (optionally for one task), `chro approval show <id>` prints the full request including the tool input and, for an AskUserQuestion prompt, its options, and `chro approval respond <id>` approves, denies with an optional reason, or answers an AskUserQuestion with `--answer "question=option"`, so a delegated or headless session can be unblocked without opening the app
- Reworked full-text search ranking: content matches are now ordered by relevance by default (files whose name matches the query first, then by how many lines matched, newest breaking ties) and can be sorted by modified date, with all sorting done on the server so it orders the whole result set instead of only reshuffling the first 50 hits. The panel now shows total files and match counts and says when results were capped, instead of silently stopping at the first 50 files found in walk order
- Added jumping straight to a file's changes in the diff: clicking a row in the Source Control list now scrolls the open diff to that file and holds it aligned while the remaining diffs stream in and the rows above it finish measuring, instead of leaving you to find it by hand
- Replaced the per-run Environment popover with a compact status pill: it shows the run's worktree branch and the branch it merges back into as "worktree → target", the aggregate additions and deletions from the same source as the Git panel so the numbers always agree, how many commits the target is ahead, and doubles as the entry point to Source Control
- Added a fullscreen preview for HTML documents that fills the app window and exits on Escape, on switching back to raw source, or when the active file changes
- Changed opening a file from the media gallery or a search hit to return focus to where you were when its tab is closed, so reviewing an image or a match and dismissing it leaves you back in the list rather than with nothing focused
- Guarded diff rendering against very large files: a changed file whose combined old and new content exceeds 512 KB is now reported as too large to render inline instead of blocking the panel while it parses

## 0.1.46

- Fixed automatic updates on macOS never being offered: the updater feed the app polls was assembled while packaging, but each architecture builds on its own runner and so never saw the other's artifact, leaving the published feed missing and the endpoint returning a 404. The feed is now built in a separate step after both signed bundles are published, from the artifacts actually released
- Added continuing a session in a new one: any conversation can branch into a fresh session that starts with the original's history and keeps working in the same worktree or a new one, without writing back into the session it came from. The new session states what it continued from, and when the branch point ended on an error (where the transcript cannot be copied) it starts from a summary of the original instead of failing
- Added delegating work between sessions: `chro task delegate "<brief>"` run inside a session starts a child session immediately, with a digest of the delegating session in its boot prompt. When every task a session delegated has finished, their results are handed back in a single packet and the delegating session wakes with it, so a session can fan work out and be resumed by the results rather than polling for them
- Reworked the model selector to be model-first: models from every runtime are listed together and picking one selects its runtime too, instead of choosing a CLI and then a model. Reasoning effort and output speed are shown per model and only when that model supports them, which adds Claude's fast mode on Opus, and a session that has already started says so rather than silently offering a runtime it cannot switch to
- Added an agent usage meter to the CLI status menu, showing how much each agent CLI has consumed in the current rolling window. It is derived entirely from the per-turn token counts the CLIs already write to their own local transcripts (no credentials, no network, nothing that competes with a running task for the account's quota), and re-reads only newly appended bytes on each refresh
- Replaced the app's interval polling of git and workspace state with change notifications: a per-worktree stream now reports file batches and git metadata changes (commits, checkouts, staging, rebases, branch tips moving), and file status, ahead/behind counts, working diffs, and `.cbase` views refresh when something actually changed instead of on a timer, while still recovering with a full refresh if notifications are ever dropped
- Reworked the command palette into a quick switcher that opens on the places worth going: sessions needing attention, recent sessions, and projects, searchable together, replacing the previous flat "sessions or commands" list
- Reworked the Source Control panel so its numbers cannot disagree with the run: the comparison base now always follows the run's own target branch instead of being separately selectable, the row states plainly which branch is compared against which base, and the totals are held back until the target branch is known rather than briefly rendering a count against a guessed base
- Added merge and rebase buttons to the Source Control panel, enabled only when they can actually do something (rebase when the branch is behind, merge when there is work to land) and refreshing ahead/behind immediately on success. A repository left mid-rebase or mid-merge says so instead of offering actions that would fail
- Fixed a run's diff showing the target branch's own commits as the run's work after a rebase: the diff stream froze its comparison base when the stream was created, so rebasing onto a moved target kept diffing against a stale merge-base until the stream happened to reconnect. The base is now re-resolved as the branch moves, recomputation is held while a rebase is in progress, and deleted files are reconciled correctly on a full pass
- Changed the worktree Files panel to stop mixing two unrelated choices in one control: Changed / All files (how much of the tree to list) stays a segmented control, while the media gallery becomes a toggle at the right edge. Opening a session to review a diff no longer lands on the gallery
- Fixed the media gallery holding thousands of images and videos open at once on a media-heavy run, each video pinning a decoder and a range request; only the visible rows are now mounted, and the grid adapts its columns to the panel or tab it is shown in
- Fixed typing becoming progressively slower in large markdown documents: every keystroke re-scanned the whole document for each of the editor's formatting features. Decorations are now refreshed only for what changed
- Added a Feature Flags section to Developer settings that lists every registered flag with its owner, retirement date, and where its rollout is decided, and allows forcing one on or off locally (with a one-click reset) without affecting anyone else
- Improved `.cbase` tables: cells can be edited inline and show the new value immediately while it saves, a table already loaded stays on screen when you switch tabs away and back or when a file changes underneath it instead of flashing a spinner, and refreshes triggered while a cell editor is open are held until the edit finishes so rows cannot move under the cursor
- Fixed `.cbase` views being slow to open in large vaults by caching parsed frontmatter per file and re-reading only files whose modification time changed, instead of re-parsing the entire vault on every query
- Fixed images and embeds not loading in documents opened from outside the current workspace root, by resolving a reference against the space its own document is addressed in rather than guessing per reference
- Fixed agent CLIs installed through npm failing to launch on Windows while working fine in a terminal: those installs are batch shims, which the Windows process API cannot execute directly, so they are now invoked through the command interpreter on both the execution and the sign-in-status paths
- Changed session rows to share one status marker everywhere they appear (sidebar and quick switcher), so an unread completed run, an unread failure, and a session whose worktree has been reclaimed read the same in every list

## 0.1.45

- Rotated the key that signs automatic updates, which every installation from 0.1.44 and earlier will refuse: the matching public key is compiled into each build, so those versions cannot verify this update or any later one and have to be reinstalled once by hand from the releases page. Installs from 0.1.45 onward carry the new key and update automatically as before. The previous key's password had been lost, which left no way to sign an update at all, so replacing it was the only way to keep automatic updates working
- Changed releases to verify before they publish rather than after: a tagged release now runs the export sanitization and third-party provenance checks first and only builds, signs, and publishes if they pass, so a failing check stops the release instead of surfacing once the installers and packages are already out
- Fixed the released source tree missing the `skills` crate and the skills panel, which made it impossible to build from a clean checkout: the rule that keeps the top-level `skills/` directory out of the published tree was not anchored to the repository root, so it also stripped `crates/skills` (a dependency of the server) and `apps/desktop/src/skills`

## 0.1.44

- Fixed the Windows app failing to reach its own server on every request and websocket, surfacing as an opaque "Failed to fetch" on actions such as picking a project folder: the packaged Windows webview serves the app from `http://tauri.localhost` instead of the `tauri://` custom scheme used on macOS and Linux, and that origin was missing from the server's allowlist
- Added file changes to the Codex conversation: patches Codex applies now stream in as a per-file edit card with a unified diff for edits, the full content for new files, and delete/rename markers, instead of being applied invisibly while only the surrounding messages showed
- Fixed Codex tool calls rendering as several stacked cards: a streaming command no longer leaves an ever-growing copy of its card behind for every chunk of output, MCP calls and web searches no longer show one card for the start and another for the result, and a call that Codex reports on both of its event streams now collapses into a single card
- Fixed a Codex approval prompt piling up into three separate entries (the pending prompt, the tool call itself, and a "user feedback" message when denied); the prompt now becomes the tool card and turns into a denied or timed-out result in place
- Fixed two Codex messages streaming at the same time being merged into one bubble, by tracking assistant replies and reasoning per message so interleaved output stays separate
- Fixed reopening a Codex session after a restart losing its entire tool history (commands and their output, MCP calls, web searches), so a restored conversation now matches what was shown live
- Fixed Codex follow-ups failing outright when a newer Codex CLI reported a thread item this version does not know about
- Moved execution logs fully out of the SQLite database into per-run JSONL files: any logs still held in the old table are exported once at first launch (atomically, never overwriting newer files, and rolled back for a retry if anything fails) before the table is dropped, keeping session resume working on pre-upgrade runs and shrinking the database file for anyone with a long log history
- Fixed replacing a session's context references and reordering the task list applying only partially when a write failed midway, by running each as a single transaction
- Added a marker for sessions whose worktree has been reclaimed by housekeeping: the sidebar shows a struck-through bullet with a tooltip, the session itself explains that its workspace is gone, and the composer is disabled rather than letting a follow-up fail in the backend

## 0.1.43

- Fixed the model picker becoming unavailable after a Codex or Pi session started, so completed turns can select a different model for the next follow-up while keeping the session's runtime fixed
- Updated the Codex model picker to the GPT-5.6 family: GPT-5.6 Sol (frontier model tuned for detail and polish on complex coding and research), GPT-5.6 Terra (everyday workhorse for general coding), and GPT-5.6 Luna (fast, efficient model for repeatable work), with GPT-5.5 kept as the previous-generation frontier option and the older GPT-5.4 and GPT-5.4-Mini entries removed
- Added `-v` / `--version` to the `chro` CLI so it prints the version and exits immediately instead of starting the server, wired the same flag into the bundled server binary, and fixed the launcher error to name Chro when a start fails
- Simplified the CLI status menu's source labels to the plain locator (for example `$CLAUDE_BIN`, `~/.local/bin/claude`, or `pi`) instead of wrapping it in `env override (…)` or `PATH (…)` text

## 0.1.42

- Moved the session Media Gallery into the Files panel's worktree view switcher, so a session worktree now toggles directly between Changed, All files, and Gallery while the Environment popover stays focused on execution, branch, rebase, and merge controls
- Added Windows release signing through SSL.com eSigner: tagged desktop releases now refuse to publish unsigned Windows installers, sign the NSIS installer when signing secrets are present, and include a manual "Verify Code Signing" workflow to catch credential problems before a full release build
- Added a Windows PE import-table check to the desktop packager that verifies bundled sidecars do not import the VC++ redistributable CRT, preventing release builds that would fail on clean Windows machines with a missing `VCRUNTIME140.dll`
- Synced desktop, server, CLI, Tauri, and Rust lockfile version metadata after the 0.1.41 release bump, so packaged builds and release artifacts report the same product version
- Documented the inter-session messaging design from first principles, added a session-persistence storage-model note comparing JSONL event logs with Chro's SQLite index, and added a Reveal.js slide deck for the messaging design

## 0.1.41

- Reworked first-run setup into a single full-screen onboarding wizard (Welcome → Agent → Theme → Open project) with a step progress indicator and Continue/Back plus Cmd+Enter/Esc navigation, replacing the old standalone setup dialog and the separate "Open a workspace" empty state so setup and opening your first project are now one guided flow
- Reworked the onboarding agent step to detect installed CLI agents (Claude Code, Codex, pi) and pick a default: a missing agent now shows its install command with a guide link and a Retry instead of a dead end, and the step re-detects automatically when you return to the window after installing in a terminal
- Removed the silent background installs and sign-in from onboarding (no more hidden `npm install -g` that could fail without telling you); agents now prompt for sign-in on first run and re-authenticate only when their token actually expires, and the manual "Reauthenticate" button next to an already signed-in agent in Settings is gone
- Added a theme step to onboarding to pick Light, Dark, or System with an immediate live preview, skippable at any time
- Reworked the left panel into three fixed sections — Pinned, Projects, and Chats — replacing the group-by dropdown; Projects still expand per repository into their sessions, and each section keeps the recent/name sort
- Added pinning for individual sessions and chats: right-click a row to Pin or Unpin, and pinned items lift to a Pinned section at the top (labeled with their originating project or "Chats"), ordered by urgency then most-recently pinned so awaiting-input and failed sessions still surface first
- Gave non-development work a first-class Chats section that lists chats directly in the sidebar, replacing the previous nameless "General" bucket, and turned the project Home header into a searchable switcher that jumps to any open project or back to Chats
- Reworked the file-search pane into a full-text search with a real query grammar: implicit AND between terms, explicit `OR`, `-` to exclude, `()` grouping, `"exact phrases"`, `/regex/`, field operators (`file:`, `path:`, `content:`, `tag:`, and `line:(…)` to require words on the same line), and `match-case:` control, defaulting to smart-case (case-sensitive only when you type an uppercase letter)
- Changed search results so files matched by content expand into collapsible, highlighted line matches while name-only matches stay a single row, with a results sort menu (file name or path, A–Z or Z–A) and a match-case toggle in the box
- Added a search helper that appears when you focus the empty search box: a clickable reference of the available operators, your last 10 recent searches (de-duplicated and remembered across restarts) to re-run or clear, and inline file-name/path autocomplete while typing a `path:` or `file:` operator
- Added an in-app feedback button to the project tab bar that opens a popover to send general feedback, a bug report, or a feature request straight to the maintainers, with a success toast, a retry prompt on failure, and a "Follow on X" link
- Replaced the top-bar update button with an always-visible version chip that opens a Release notes modal listing the app's changelog newest-first with your running version marked "Current"; the update prompt is now a separate button that appears only when an update is actually available (download and install, restart-to-install, or retry), and the modal also carries a "Check for updates" action
- Added a CLI status menu to the title bar showing each coding-agent CLI and chro's own CLI — whether it was found on PATH, the resolved path and source, and the version it reports — plus the latest published chro release, with an amber warning dot and a click-to-copy `npm install -g` command when a newer release is available or a stale binary is shadowing the intended one on PATH
- Added a list/tree toggle to the Source Control panel's changed-file lists, nesting files under their folders with single-child folder chains collapsed into one row, remembered across reloads
- Fixed sessions getting stuck forever on a running spinner when a run's setup was interrupted (navigating away or the app crashing mid-provisioning): session creation now finishes on the server independent of the request, a failed setup step marks the run failed and releases the session, and any leftover half-created sessions are finalized at startup instead of lingering as zombies
- Fixed pressing Stop during the brief window before a run appears silently doing nothing; it now cancels the run as soon as it exists
- Fixed opening a different session while a new one was still being created yanking your view back to the just-created session

## 0.1.40

- Added server-side materialization for referenced sessions: sessions attached from the composer or `--ref-session` now inject a bounded digest into the executor prompt at run start and follow-up time, including the referenced session title, branch, latest status, last user/assistant exchange, and a `chro task logs <task_id>` pointer for the full transcript
- Fixed the bundled `chro task logs` path so task IDs and slugs fall back to the task transcript endpoint when they are not run IDs, making referenced-session escalation links resolve instead of returning a run-log 404
- Added global workspace shortcuts: Cmd/Ctrl+K and Cmd/Ctrl+P open the session-search palette, Cmd/Ctrl+Shift+F opens file search, and Cmd/Ctrl+N starts a new chat
- Moved the session-search palette out of the projects dock so it opens from the same shared modal whether triggered by the sidebar button or a keyboard shortcut, including when the left dock is collapsed
- Refined workspace chrome with keyboard shortcut hints, hover tooltips for icon-only controls, and quieter projects-panel hover and active states across search, new chat, side-panel toggles, Open in, diff close, and skill-folder actions
- Documented the inter-session collaboration / Links roadmap and the session-ref materialization design, including the planned handoff, message/follow-up, and delegation rails

## 0.1.39

- Fixed shell commands an agent runs (including git hooks) failing with "command not found" for tools installed through your login shell — Homebrew, nvm, bun, rbenv, cargo, and the like — when the app is launched from the GUI: the app now merges your login shell's `PATH` at startup so those tools resolve the same way they do in your terminal
- Fixed live views such as the session list and conversations silently drifting out of date when their update stream briefly fell behind: the server now detects a backlogged stream and resends a fresh snapshot to catch the client back up, and subscribes before taking that snapshot so no update can slip through the gap at connect time
- Fixed a record occasionally rendering blank or stale when an update for it arrived before the insert that created it, by applying such an early update as an insert instead of silently dropping it

## 0.1.38

- Added support for the Pi coding agent alongside Claude Code and Codex: install it from the setup flow, sign in with provider API keys (OpenAI, Google, Anthropic, OpenRouter, and custom providers) managed in Settings or through the terminal login dialog, pick from its live model catalog, and run full multi-turn sessions with follow-ups, forks, and cancellation
- Added a spreadsheet editor for CSV and TSV files with in-cell editing, arrow/Tab navigation, click-drag and Shift-click range selection, clipboard copy/cut/paste, row and column insert/delete, and draggable column widths, saving through the regular autosave path and staying read-only where the file tree is read-only
- Added an opt-in "Headless mode (claude -p)" setting that runs Claude non-interactively for batch and parallel work (approvals and clarifying questions are disabled there), and made each session remember the engine it started with so toggling the setting mid-session no longer breaks follow-ups and retries
- Added drag-and-drop file attachment to the message composer, which highlights and switches its placeholder to "Drop files here to attach" while a file drag is over it
- Reworked the agent picker into a two-step runtime-then-model menu with a search box for long model lists
- Added "Copy absolute path" and "Reveal in Finder" to the file tree's context menu in session scope, resolving against the session's worktree on disk
- Added a Collapse-all button to the projects panel toolbar
- Refreshed the app's visual design: the Inter typeface now ships with the app (text previously fell back to the OS font), on a unified color palette with quieter shadows and borders and refined spacing across the file tree, docks, working steps, and menus, plus a more compact empty composer
- Replaced raw crash screens with a friendly localized error view offering Retry, Reload, and Go to start, with expandable error details, a copy button, and graceful handling of repeating errors
- Moved .cbase view parsing, filtering, and sorting plus file-tree git status decoration to the Rust backend, so large vaults no longer index on the UI thread and the file tree hydrates its change badges in a single request
- Made the Worktree Directories list in developer settings appear immediately, with folder sizes computed in the background instead of blocking the whole list
- Fixed Claude runs that hit an API error (rate limit, usage or session limit) being recorded as successful completions with no output: the turn now fails with the CLI's actual message and offers a one-click Retry
- Fixed sessions staying in a "running" state forever when the agent process crashed or errored out: abnormal exits now mark the run failed and release the session immediately
- Fixed loading spinners getting stuck when a stream stalled or dropped: reconnection now distinguishes rejected handshakes (which stop after a few attempts) from transient drops (which keep retrying), leaves legitimately idle streams alone, and lets deleted sessions reject cleanly instead of erroring
- Fixed conversation messages occasionally jumping out of order after a few turns by ordering runs on server-authoritative timestamps, and cleared the sidebar's running spinner as soon as a turn finishes instead of after the background auto-commit
- Fixed a newly created session vanishing from the session list after its first reply (until reload) and duplicate rows appearing when the real session streamed in before the create request returned
- Made archiving work for sessions stuck in a running state by cancelling the orphaned run first, and kept the archive action available on every session row
- Removed the developer Feature Flags section from Settings; flags now resolve from built-in defaults with no local overrides

## 0.1.37

- Added a Media Gallery tab that shows the images and videos an agent has produced as a thumbnail grid, read from disk newest-first and gitignore-aware, scoped either to a single session's worktree or to the whole project, and opened from the new Environment popover
- Reworked the session header's scattered execution controls and the standalone rebase dialog into a single "Environment" popover that gathers the worktree-vs-local toggle, the base branch ("From") picker, the changes/review summary, gallery access, rebase, merge-into-base, git-repository initialization, and the task's ID and branch in one place
- Added a terminal-based sign-in dialog that runs the agent's login flow (Claude Code or Codex) inside an embedded terminal, so you authenticate by opening the URL it prints and entering the code, which also works over a remote server with no browser redirect needed
- Added a "Create git repository" action so a project that is not yet a Git repository can be initialized in place, after which worktree-isolated sessions and base-branch selection become available
- Added an Expand control on rendered Mermaid diagrams that opens a larger, zoomable view
- Fixed runs silently stopping when the agent emitted a tool call the CLI could not parse even after its own retry (an intermittent model-side abort): the turn is now marked failed with a clear explanation and a one-click Retry to continue from where it stopped
- Bundled the chro terminal CLI alongside the desktop app and added it to the PATH of agents the app launches, so an agent can invoke `chro task ...` by bare name to drive sub-tasks
- Added a task references popover (Uses / Referenced by) to the session composer, and cleaned up the feature-flag list now that the structured question UI and canvas terminal renderer are the default

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
