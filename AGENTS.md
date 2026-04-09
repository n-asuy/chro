# Repository Guidelines

## Project Structure & Module Organization
- Monorepo managed by Turborepo and Bun.
- Apps in `apps/` (e.g., `api` Rust on Cloudflare Workers, `desktop` Electron, `cli` Rust launcher).
- Shared packages in `packages/` (currently `ui`).
- Tooling and scripts in `tooling/` (TypeScript configs, license checks, CI helpers).

## Build, Test, and Development Commands
- `bun dev`: Run all app dev tasks in parallel.
- `bun dev:desktop` | `bun dev:cli` | `bun dev:api`: Run a single app from repo root.
- `bun run --filter=@chro/desktop dev:web`: Run the desktop frontend and Rust server without Electron.
- `bun build`: Build all workspaces.
- `bun test`: Run tests across workspaces.
- `bun typecheck`: Type-check all workspaces.
- `bun lint` | `bun format`: Lint (Turbo + Sherif) and format (Biome).
- `bun clean` | `bun clean:workspaces`: Remove deps/artifacts.
- Scope any task: `turbo <task> --filter=@chro/desktop`.

## Coding Style & Naming Conventions
- Formatting and linting via Biome; run `bun format` and `bun lint` before PRs.
- TypeScript-first. Organized imports enforced.
- Naming: camelCase (vars/functions), PascalCase (components/types), kebab-case (files/dirs). Example: `packages/ui/button/button.tsx` with `Button` export.

## Testing Guidelines
- Prefer colocated tests: `*.test.ts`/`*.test.tsx` next to source.
- Run all: `bun test`. Target a package: `bun run --filter=@chro/cli test`.
- Keep tests deterministic; avoid external network. Use fakes/mocks for Workers APIs.

## Commit & Pull Request Guidelines
- Commits: short, imperative, lowercase (history examples: "design", "sidebar", "fix words").
- PRs must include: concise description, scope (apps/packages touched), linked issues, screenshots for UI, and test/QA notes.
- Ensure `bun format && bun lint && bun typecheck && bun build` pass.

## Security & Configuration Tips
- Never commit secrets. Use per-app `.env` files and Cloudflare `wrangler secret put` for production.
- Examples: copy `apps/*/.env.example` to `.env`; API dev vars in `apps/api/.dev.vars`.
- Reset local Workers state if needed: remove `apps/*/.wrangler/state` and re-run migrations.
