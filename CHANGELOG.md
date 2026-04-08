# Changelog

## 0.1.18

- Added `.cbase` serializer to persist table view state (column visibility, sort order) back to `.cbase` files on disk
- Added `onColumnsChange` and `onSortChange` callbacks to cbase table, enabling auto-save of user-driven view changes
- Added `resolveDefaultColumns()` with sensible defaults (`file.path`, `file.name`, `file.mtime`) instead of showing all properties
- Added session empty state component with branded Chro logo placeholder for empty sessions
- Added i18n key for session input placeholder, replacing hardcoded English text
- Changed cbase viewer to skip persistence for query-language-based definitions
