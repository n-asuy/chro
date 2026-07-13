# crates/db

Database layer for Chro desktop application using SQLite.

## Overview

This crate provides:
- SQLite schema based on `docs/table-design.html` (Task-centric design)
- Type-safe models with `sqlx`, `serde`, and `ts-rs`
- Support for both local (Phase 1) and remote (Phase 2) execution modes
- Schema versioning via `app_meta` table

## Design Philosophy

### Task-Centric Architecture

This design eliminates the legacy "Attempt" layer, consolidating execution context into:
- `TaskRecord`: The core entity representing a task
- `TaskRun`: Execution history (multiple runs per task)

### Execution Modes

**Phase 1 (Current): Local Execution**
- Uses git worktree for task isolation
- Logs stored as per-run JSONL files outside SQLite
- `worktree_path` field used

**Phase 2 (Future): Remote Execution**
- Uses Northflank Jobs for execution
- Logs stored in S3/MinIO (URI in `logs_uri`)
- `executor_job_id`, `s3_prefix`, `*_uri` fields used

The schema supports both modes via nullable fields and `execution_mode` enum.

## Module Organization

```
src/
├── lib.rs              # DBService, connection management
├── types.rs            # Shared enums (ExecutionMode, TaskStatus, etc.)
└── models/
    ├── core/           # Task-related models (tightly coupled)
    │   ├── project.rs
    │   ├── agent.rs
    │   └── task.rs     # TaskRecord, TaskRun
    ├── collab/         # Session, merge, draft
    │   ├── session.rs
    │   ├── merge.rs
    │   └── draft.rs
    ├── automation/     # Templates, recurrences
    │   ├── template.rs
    │   └── recurrence.rs
    └── assets/         # Images
        └── image.rs
```

### Rationale

- **core/task.rs**: Task and TaskRun are tightly coupled and grouped together
- **Modular separation**: Session/merge/draft grouped by collaboration concerns
- **Clear boundaries**: Automation and assets isolated for independent evolution

## Coding Conventions

### Required Derives

All model structs MUST include:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export)]
pub struct MyModel {
    // ...
}
```

### Field Type Mapping

| Rust Type | SQLite Type | Notes |
|-----------|-------------|-------|
| `Uuid` | `BLOB` | Use `#[sqlx(try_from = "Vec<u8>")]` |
| `DateTime<Utc>` | `TEXT` | Use `#[sqlx(try_from = "String")]` |
| `bool` | `INTEGER` | 0 or 1, CHECK constraint recommended |
| `JsonValue` | `TEXT` | Use `#[sqlx(try_from = "Option<String>")]` for nullable |
| Custom enum | `TEXT` | Implement `Type`, `Encode`, `Decode` traits |

### Enum Implementation Pattern

All enums used in database fields MUST implement:

```rust
impl Type<Sqlite> for MyEnum { /* ... */ }
impl<'q> Encode<'q, Sqlite> for MyEnum { /* ... */ }
impl<'r> Decode<'r, Sqlite> for MyEnum { /* ... */ }
```

See `src/types.rs` for reference implementations.

### Constructor Patterns

Models should provide semantic constructors:

```rust
impl TaskRecord {
    pub fn new(project_id: Uuid, title: impl Into<String>, ...) -> Self { /* ... */ }
    pub fn new_subtask(project_id: Uuid, parent_id: Uuid, ...) -> Self { /* ... */ }
}

impl TaskRun {
    pub fn new_local(task_id: Uuid, ...) -> Self { /* ... */ }
    pub fn new_remote(task_id: Uuid, job_id: String, ...) -> Self { /* ... */ }
}
```

### State Mutation Methods

Provide methods for state transitions:

```rust
impl TaskRun {
    pub fn start(&mut self) { /* set status, started_at */ }
    pub fn complete(&mut self, exit_code: i32) { /* set status, completed_at */ }
    pub fn cancel(&mut self) { /* set status, completed_at */ }
}
```

## Schema Versioning

The `app_meta` table tracks schema version:

```sql
CREATE TABLE app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO app_meta(key, value) VALUES ('db_schema_version', '1');
```

Access via `DBService::schema_version()`:

```rust
let version = db.schema_version().await?;
assert_eq!(version, 5);
```

## Migration Guidelines

- Migrations live in `migrations/` directory
- Naming: `YYYYMMDDHHMMSS_description.sql` (numeric prefix only, e.g., `20251120000002_run_metadata.sql`)
- Avoid additional underscores or characters before the first `_`; SQLx reads only the leading digits for the version number.
- Increment `db_schema_version` in `app_meta` when adding migrations
- Use `sqlx::migrate!()` in `DBService::new*()` to auto-apply migrations

### Important Schema Details

**Directory Creation**: `DBService::new()` and `new_with_path()` automatically create parent directories if they don't exist. This ensures the database can be initialized on first run without manual directory setup.

**Template Uniqueness**: Task templates use partial indexes to enforce uniqueness:
- Global templates (project_id IS NULL): unique by `template_name`
- Project templates (project_id IS NOT NULL): unique by `(project_id, template_name)`

This design prevents duplicate template names while allowing the same name across different scopes.

## Testing

All models include basic unit tests. Run with:

```bash
cargo test
```

Key test coverage:
- Constructor behavior
- State transitions
- Field validation
- Serialization/deserialization

## TypeScript Generation

Models with `#[ts(export)]` can generate TypeScript types:

```bash
# Generate bindings (not yet configured)
cargo test  # ts-rs generates during build
```

Generated types will be available for Electron frontend integration.

## Dependencies

| Crate | Purpose |
|-------|---------|
| `sqlx` | Async SQLite driver, compile-time query checking |
| `serde` | Serialization for JSON fields and API |
| `ts-rs` | TypeScript type generation |
| `uuid` | Primary key generation |
| `chrono` | Timestamp handling |
| `thiserror` | Error types |
| `dirs` | Cross-platform data directory resolution |

## Usage Example

```rust
use db::{DBService, models::*};

#[tokio::main]
async fn main() -> Result<(), sqlx::Error> {
    // Initialize database
    let db = DBService::new().await?;

    // Create a project
    let project = ProjectRecord::new("my-project", "/path/to/repo");

    // Create a task
    let task = TaskRecord::new(project.id, "Implement feature X", None);

    // Create a local execution run
    let run = TaskRun::new_local(task.id, Some("Initial implementation".into()));

    Ok(())
}
```

## Future Enhancements

- [ ] Query builders for common operations
- [ ] Repository pattern for encapsulating CRUD operations
- [ ] Database connection pooling optimization
- [ ] Soft delete support
- [ ] Audit logging
- [ ] Full-text search on task descriptions

## References

- Design: `docs/table-design.html`
- Infrastructure: `docs/infra-design.html`
- Legacy schema notes: `docs/table-design.html`

---

**Last updated**: 2026-07-12
