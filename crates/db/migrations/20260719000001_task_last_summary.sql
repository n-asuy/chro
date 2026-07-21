-- One-line outcome of the task's latest completed run, denormalized onto the
-- task record so list surfaces (sidebar rows, hover preview) can show "what
-- this session did" without a per-task transcript lookup. Mirrors the
-- `last_executor` denormalization contract.
--
-- No backfill: deriving the outcome requires parsing run transcripts, which is
-- done at run-completion time going forward. Historical tasks simply have no
-- summary until their next run.
ALTER TABLE task_records ADD COLUMN last_summary TEXT;
