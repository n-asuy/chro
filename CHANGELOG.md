# Changelog

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
