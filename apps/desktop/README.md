# @chro/desktop

Electron desktop application with a React SPA renderer. The frontend uses TanStack Router (file-based routing), Vite, Zustand, and Tailwind CSS. A bundled Rust server (Axum) handles backend logic, database persistence, and real-time streaming.

## Development

```bash
bun dev
```

This starts three processes concurrently:

| Process | Command | Port |
|---------|---------|------|
| Rust server | `cargo run ... chro-server` | `4310` |
| Vite dev server | `vite` | `3400` |
| Electron shell | `electron .` | — |

### Web-only (no Electron)

```bash
bun dev:web
```

Runs only the Rust server and Vite. The app is accessible at `http://localhost:3400` in any browser, useful for rapid UI iteration.

In dev, `dev:vite` also builds a small `napi-rs` addon (`.native/chro-filesystem.node`) and uses it for fast local handling of:

- `GET /rpc/projects/:projectId/entries`
- `GET /rpc/projects/:projectId/file`

Set `CHRO_ENABLE_NAPI_FS=0` to disable the addon and force pure HTTP proxy behavior.

The bundled Rust server now uses an explicit CORS allowlist. Defaults cover the desktop renderer in dev (`http://localhost:3400`, `http://127.0.0.1:3400`) and the packaged app (`app://.`). Add browser extension origins with `CHRO_ALLOWED_ORIGINS`, for example `CHRO_ALLOWED_ORIGINS=chrome-extension://<extension-id>`.

## Directory Layout

```
apps/desktop/
├── src/                    # React SPA (renderer process)
│   ├── main.tsx            # Entry point
│   ├── routes/             # TanStack Router file-based routes
│   │   ├── __root.tsx      # Root layout with providers
│   │   ├── index.tsx       # Home / onboarding
│   │   └── projects/
│   │       └── $projectId/
│   │           ├── files.tsx   # File explorer
│   │           ├── session/    # Agent session view
│   │           └── settings.tsx
│   ├── tasks/              # Task / project data layer (API, types)
│   ├── files/              # File explorer (state, components)
│   ├── session/            # Agent session (state, components)
│   ├── sidebar/            # Sidebar navigation
│   ├── settings/           # Settings UI
│   ├── components/         # Shared React components
│   ├── dialogs/            # Modal dialogs
│   ├── lib/                # API clients and utilities
│   │   ├── backend-client.ts
│   │   ├── desktop-bridge.ts
│   │   ├── executor-client.ts
│   │   ├── git-client.ts
│   │   └── workspace-client.ts
│   ├── hooks/              # Global custom hooks
│   ├── types/              # TypeScript type definitions
│   ├── i18n/               # Internationalization
│   └── styles/             # Global CSS
├── electron/               # Electron main process
│   ├── main.ts             # Window management, app lifecycle
│   ├── preload.ts          # IPC bridge (contextBridge)
│   ├── db.ts               # SQLite setup
│   ├── protocol.ts         # Custom protocol handlers
│   ├── tray.ts             # System tray
│   └── shell-utils.ts      # Shell integration
├── public/                 # Static assets
├── assets/                 # App icons and logos
├── build/                  # macOS entitlements
├── scripts/                # Build and deploy scripts
├── index.html              # Root HTML
├── vite.config.ts          # Vite configuration
├── tailwind.config.ts      # Tailwind CSS configuration
└── package.json            # Dependencies and build config
```

## Key Patterns

### State Management

- **Zustand** stores for local UI state (task board, file tree, session, prompt editor).
- **React Query** for server state, caching, and optimistic updates.
- **React Context** for global providers (language, settings modal).

### IPC Bridge

The Electron preload script exposes `window.desktop` via `contextBridge`:

- `desktop.selectWorkspace()` — native folder picker
- `desktop.update.check()` / `desktop.update.download()` — auto-updates

### API Clients

HTTP clients in `src/lib/` communicate with the Rust backend on port `4310`:

- `taskApi` — task CRUD and RPC endpoints
- `workspaceClient` — workspace management
- `gitClient` — git operations (commit, branch, diff)
- `executorClient` — agent executor profiles
- `filesystemApi` — file read/write/search

### Routing

TanStack Router with file-based routing in `src/routes/`. Dynamic segments use `$param` convention (e.g., `$projectId`, `$taskId`).

## Building & Packaging

```bash
bun run build            # Vite build + Electron TypeScript compilation
bun run package          # Package with electron-builder
bun run package:release  # Build, package, and publish
```

`electron-builder` is configured for:
- **macOS** — dmg (signed and notarized)
- **Windows** — nsis + zip
- **Linux** — AppImage

The packaged app bundles:
- Compiled Vite output (`dist-vite/`)
- Compiled Electron code (`dist-electron/`)
- Rust server binary (`chro-server`)
