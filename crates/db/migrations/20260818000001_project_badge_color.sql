-- Identity color for a project, rendered as a small dot next to its name in
-- the sidebar. Stored as a preset palette name (theme-aware) or a normalized
-- "#rrggbb" hex string; NULL means no color (no dot).
ALTER TABLE project_records ADD COLUMN badge_color TEXT;
