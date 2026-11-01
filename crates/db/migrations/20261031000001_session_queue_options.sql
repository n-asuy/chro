-- How a queued message is to be sent when it becomes a turn: images, context
-- references, skills, executor profile and mode, as JSON owned by the runtime.
-- NULL means a plain text message continuing the session.
ALTER TABLE session_queue ADD COLUMN options TEXT;
