-- The queue's order, which a person can change. Lower goes first; arrival
-- order (rowid) breaks ties. Existing messages keep their arrival order.
ALTER TABLE session_queue ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
UPDATE session_queue SET seq = rowid;
