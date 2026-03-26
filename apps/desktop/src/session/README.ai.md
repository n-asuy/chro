# Session Module Guide (AI/Human)

## Goals

- Keep `single-agent-session.tsx` focused on composition and rendering.
- Keep session execution behavior in hooks and domain functions.
- Keep a machine-readable map of symbols and RPC references.

## Layering Rules

- `single-agent-session.tsx`: page composition and UI wiring only.
- `hooks/*`: side effects, fetch orchestration, stream control.
- `domain/*`: pure functions and deterministic transformations.
- `types/*`: transport/data contracts only.

## Code Map

- Generate: `bun run codemap:session`
- Output: `apps/desktop/src/session/SESSION_CODEMAP.md`
- Use cases:
  - quick review of exports and ownership
  - AI context priming before edits
  - RPC dependency visibility

## Refactor Checklist

1. Move pure logic to `domain/*` first.
2. Add tests for domain functions.
3. Move async orchestration into hooks.
4. Regenerate codemap and include in diff.
