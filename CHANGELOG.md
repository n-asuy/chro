# Changelog

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
