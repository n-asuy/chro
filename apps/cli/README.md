# Chro CLI

`apps/cli` provides the `chro` launcher plus the npm wrapper that downloads a
platform-specific Rust binary from R2.

## What It Does

- Starts `chro-server` and the Vite web surface directly
- Does not delegate to `bun run dev:web`
- Keeps the CLI surface to a single `chro` command
- Downloads `chro.zip` from R2 during `postinstall` or on first run

## Local Development

```bash
cd apps/cli
cargo run --
cargo run -- --perf
```

The binary locates the repo root at runtime, so installed copies still need to
be run from inside a Chro checkout unless `CHRO_REPO_ROOT` is set explicitly.

## Packaging

```bash
cd apps/cli
bash ./local-build.sh
```

This builds the Rust binary, zips it into `npx-cli/dist/<platform>/chro.zip`,
syncs the npm package version from `Cargo.toml`, and creates an npm tarball in
`apps/cli/npx-cli/`.

## Release

```bash
cd apps/cli
R2_ENDPOINT=...
R2_BUCKET=...
R2_PUBLIC_URL=...
bash ./release.sh
```

`release.sh` uploads `chro.zip` to R2, stores the resolved public base URL in
the npm package metadata, and then runs `npm publish`.

Optional:

- `R2_PREFIX` to upload under a bucket subpath
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` if AWS credentials are not
  already exported

## Notes

- `bun` must be installed
- workspace dependencies must already be installed with `bun install`
- this command is intended for local development inside the repository
- if either `chro-server` or Vite exits, `chro` stops the other process too
