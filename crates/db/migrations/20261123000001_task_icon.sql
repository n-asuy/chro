-- Icon for a session: the name of one of the desktop's line icons, picked by
-- the call that titles the session or chosen by a person. NULL means the
-- desktop draws its neutral default.
ALTER TABLE task_records ADD COLUMN icon TEXT;
