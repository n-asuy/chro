//! Titles Claude Code assigns to its own sessions.
//!
//! After the first turn the CLI appends an `ai-title` record to the session
//! transcript (`~/.claude/projects/<project>/<session>.jsonl`) and re-emits it
//! as the conversation evolves; `/rename` appends a `custom-title` record. The
//! latest record of each kind is authoritative, and a person's rename beats a
//! generated title regardless of order.

use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use serde::Deserialize;

use crate::executors::{SessionTitle, SessionTitleSource};

#[derive(Deserialize)]
#[serde(tag = "type")]
enum TitleRecord {
    #[serde(rename = "ai-title")]
    Generated {
        #[serde(rename = "aiTitle")]
        title: String,
    },
    #[serde(rename = "custom-title")]
    Custom {
        #[serde(rename = "customTitle")]
        title: String,
    },
}

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

pub(super) fn session_title(cwd: &Path, session_id: &str) -> Option<SessionTitle> {
    session_title_in(&projects_dir()?, cwd, session_id)
}

fn session_title_in(projects_dir: &Path, cwd: &Path, session_id: &str) -> Option<SessionTitle> {
    let file = File::open(transcript_path_in(projects_dir, cwd, session_id)?).ok()?;
    title_from_transcript(BufReader::new(file).lines().map_while(Result::ok))
}

fn title_from_transcript(lines: impl Iterator<Item = String>) -> Option<SessionTitle> {
    let mut generated = None;
    let mut custom = None;
    for line in lines {
        // Transcript lines can be megabytes of tool output; only the two title
        // record kinds are worth parsing.
        if !line.contains("-title\"") {
            continue;
        }
        match serde_json::from_str::<TitleRecord>(&line) {
            Ok(TitleRecord::Generated { title }) => generated = non_blank(title).or(generated),
            Ok(TitleRecord::Custom { title }) => custom = non_blank(title).or(custom),
            Err(_) => {}
        }
    }
    custom
        .map(|title| SessionTitle {
            title,
            source: SessionTitleSource::Custom,
        })
        .or_else(|| {
            generated.map(|title| SessionTitle {
                title,
                source: SessionTitleSource::Generated,
            })
        })
}

fn non_blank(title: String) -> Option<String> {
    let trimmed = title.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(records: &[&str]) -> std::vec::IntoIter<String> {
        records
            .iter()
            .map(|record| record.to_string())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn takes_the_latest_generated_title() {
        let title = title_from_transcript(lines(&[
            r#"{"type":"user","message":{"role":"user","content":"fix the bug"}}"#,
            r#"{"type":"ai-title","aiTitle":"Bug fix","sessionId":"s"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ai-title\" noise"}]}}"#,
            r#"{"type":"ai-title","aiTitle":"Login bug fix in auth.rs","sessionId":"s"}"#,
        ]));
        assert_eq!(
            title,
            Some(SessionTitle {
                title: "Login bug fix in auth.rs".to_string(),
                source: SessionTitleSource::Generated,
            })
        );
    }

    #[test]
    fn custom_title_beats_a_later_generated_one() {
        let title = title_from_transcript(lines(&[
            r#"{"type":"custom-title","customTitle":"My name","sessionId":"s"}"#,
            r#"{"type":"ai-title","aiTitle":"Generated later","sessionId":"s"}"#,
        ]));
        assert_eq!(
            title,
            Some(SessionTitle {
                title: "My name".to_string(),
                source: SessionTitleSource::Custom,
            })
        );
    }

    #[test]
    fn blank_and_malformed_records_are_ignored() {
        let title = title_from_transcript(lines(&[
            r#"{"type":"ai-title","aiTitle":"  Real title  "}"#,
            r#"{"type":"ai-title","aiTitle":"   "}"#,
            r#"{"type":"ai-title","aiTitle":"#,
        ]));
        assert_eq!(title.map(|t| t.title).as_deref(), Some("Real title"));
        assert_eq!(title_from_transcript(lines(&[r#"{"type":"user"}"#])), None);
    }

    #[test]
    fn reads_the_transcript_of_the_cwd_project_or_any_other_project() {
        let projects = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let own_dir = projects.path().join(project_dir_name(cwd.path()));
        let other_dir = projects.path().join("-some-other-worktree");
        std::fs::create_dir_all(&own_dir).unwrap();
        std::fs::create_dir_all(&other_dir).unwrap();
        std::fs::write(
            own_dir.join("here.jsonl"),
            "{\"type\":\"ai-title\",\"aiTitle\":\"Started here\"}\n",
        )
        .unwrap();
        std::fs::write(
            other_dir.join("elsewhere.jsonl"),
            "{\"type\":\"ai-title\",\"aiTitle\":\"Started elsewhere\"}\n",
        )
        .unwrap();

        let here = session_title_in(projects.path(), cwd.path(), "here").unwrap();
        assert_eq!(here.title, "Started here");
        let elsewhere = session_title_in(projects.path(), cwd.path(), "elsewhere").unwrap();
        assert_eq!(elsewhere.title, "Started elsewhere");
        assert_eq!(
            session_title_in(projects.path(), cwd.path(), "missing"),
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
