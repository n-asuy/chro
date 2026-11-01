//! Where Claude Code keeps a session's transcript
//! (`~/.claude/projects/<project>/<session>.jsonl`).

use std::path::{Path, PathBuf};

/// The project-dir name Claude Code derives from a working directory: the
/// canonical path with every non-alphanumeric character replaced by `-`.
/// Verified empirically (`/tmp/ab_c.d` → `-private-tmp-ab-c-d`).
pub(super) fn project_dir_name(cwd: &Path) -> String {
    let canonical = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    canonical
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Where the CLI keeps session transcripts, honoring the same config-dir
/// override the CLI itself reads.
pub(super) fn projects_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .filter(|dir| !dir.as_os_str().is_empty())
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))
        .map(|dir| dir.join("projects"))
}

/// Where `session_id`'s transcript lives: under `cwd`'s own project dir when
/// it was started there, otherwise the first project dir that has it (a
/// session resumed from a different worktree of the same repo keeps its
/// original home).
pub(super) fn transcript_path(cwd: &Path, session_id: &str) -> Option<PathBuf> {
    transcript_path_in(&projects_dir()?, cwd, session_id)
}

fn transcript_path_in(projects_dir: &Path, cwd: &Path, session_id: &str) -> Option<PathBuf> {
    let file_name = format!("{session_id}.jsonl");
    let own = projects_dir.join(project_dir_name(cwd)).join(&file_name);
    if own.is_file() {
        return Some(own);
    }
    std::fs::read_dir(projects_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(&file_name))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_transcript_in_the_cwd_project_or_any_other_project() {
        let projects = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let own_dir = projects.path().join(project_dir_name(cwd.path()));
        let other_dir = projects.path().join("-some-other-worktree");
        std::fs::create_dir_all(&own_dir).unwrap();
        std::fs::create_dir_all(&other_dir).unwrap();
        std::fs::write(own_dir.join("here.jsonl"), "{}\n").unwrap();
        std::fs::write(other_dir.join("elsewhere.jsonl"), "{}\n").unwrap();

        assert_eq!(
            transcript_path_in(projects.path(), cwd.path(), "here"),
            Some(own_dir.join("here.jsonl"))
        );
        assert_eq!(
            transcript_path_in(projects.path(), cwd.path(), "elsewhere"),
            Some(other_dir.join("elsewhere.jsonl"))
        );
        assert_eq!(
            transcript_path_in(projects.path(), cwd.path(), "missing"),
            None
        );
    }

    #[test]
    fn project_dir_name_folds_every_separator_to_dashes() {
        assert_eq!(
            project_dir_name(Path::new("/nonexistent/ab_c.d")),
            "-nonexistent-ab-c-d"
        );
    }
}
