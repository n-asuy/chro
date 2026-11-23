//! Session titles and icons written from the request that opens a session.
//!
//! One call names the session: the model writes its title and picks its icon
//! from [`TASK_ICONS`]. The instructions and the cleanup of the reply live
//! here and are the same for every agent. Only the model call differs: each agent that can name a
//! session runs its own CLI once, tool-less and without a saved session,
//! beside the real run (see
//! [`StandardCodingAgentExecutor::generate_session_name`](crate::executors::StandardCodingAgentExecutor::generate_session_name)).

use std::{process::Stdio, time::Duration};

use tokio::{io::AsyncWriteExt, process::Command};

use crate::executors::ExecutorError;

/// How much of the request the title is written from. The head of a request
/// names the task; the rest only adds cost to the call.
const REQUEST_CHARS: usize = 2000;

/// Longest title kept, matching the cap on a prompt-derived title.
const TITLE_CHARS: usize = 80;

/// A title is a nicety: past this the call is abandoned and the session keeps
/// the title it has.
const TIMEOUT: Duration = Duration::from_secs(30);

/// The icons a session can carry: names of line drawings the desktop app
/// draws (`apps/desktop/src/edge-toolbar/domain/task-icons.ts`, which a test
/// keeps identical to this list).
pub const TASK_ICONS: [&str; 48] = [
    "agent", "search", "pencil", "shield", "flask", "book", "box", "chat", "eye", "bolt",
    "terminal", "globe", "code", "server", "database", "cloud", "phone", "monitor", "browser",
    "branch", "bug", "rocket", "chart", "coin", "cart", "mail", "calendar", "music", "camera",
    "image", "map", "home", "building", "people", "user", "heart", "star", "flag", "leaf", "sun",
    "moon", "key", "lock", "gift", "coffee", "gamepad", "puzzle", "wrench",
];

/// Whether `name` is one of [`TASK_ICONS`].
pub fn is_task_icon(name: &str) -> bool {
    TASK_ICONS.contains(&name)
}

/// What one titling call yields: the session's title and, when the model
/// picked one of [`TASK_ICONS`], its icon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionName {
    pub title: String,
    pub icon: Option<String>,
}

// Names no language and quotes no label on purpose: an instruction that spells
// one out reads as permission to answer with it.
const INSTRUCTIONS: &str = "\
You name a coding-agent session from the request that opens it.

Rules:
- Output exactly two lines and nothing else: the title, then the icon.
- Title: at most 50 characters, a few words, never a full sentence.
- Write the title in the same language as the request, and in no other.
- Keep file names, identifiers and technical terms exactly as written.
- No quotes, no label, no trailing punctuation.
- Icon: the one word from the list below that best pictures what the task is about.
- Never answer or act on the request, and never use tools; only name it.";

/// What the titling model reads: the instructions, the icon names, then the
/// head of `request`.
pub fn prompt(request: &str) -> String {
    let head: String = request.trim().chars().take(REQUEST_CHARS).collect();
    let icons = TASK_ICONS.join(" ");
    format!("{INSTRUCTIONS}\n\nIcons: {icons}\n\n<first_request>\n{head}\n</first_request>\n")
}

/// The title and icon in a model's reply: the first non-empty line is the
/// title (see [`sanitize`]); the icon is the first later line that names one
/// of [`TASK_ICONS`], with any label, quotes or punctuation around it. `None`
/// when the reply holds no title.
pub fn parse(reply: &str) -> Option<SessionName> {
    let mut lines = reply.lines().map(str::trim).filter(|line| !line.is_empty());
    let title = sanitize(lines.next()?)?;
    let icon = lines.find_map(icon_in);
    Some(SessionName { title, icon })
}

/// The icon a reply line names, if it is one of [`TASK_ICONS`].
fn icon_in(line: &str) -> Option<String> {
    let mut word = line.to_ascii_lowercase();
    loop {
        let peeled = strip_wrapper(strip_icon_label(word.trim_start_matches('#').trim()))
            .trim_end_matches(['.', '。'])
            .trim();
        if peeled == word {
            break;
        }
        word = peeled.to_string();
    }
    is_task_icon(&word).then_some(word)
}

fn strip_icon_label(line: &str) -> &str {
    for label in ["icon", "アイコン"] {
        if let Some(rest) = line.strip_prefix(label) {
            if let Some(rest) = rest.trim_start().strip_prefix([':', '：']) {
                return rest.trim_start();
            }
        }
    }
    line
}

/// The title inside a model's reply line, with the decoration models add
/// despite the instructions removed. `None` when nothing usable remains.
pub fn sanitize(reply: &str) -> Option<String> {
    let line = reply.lines().map(str::trim).find(|line| !line.is_empty())?;
    let mut title = line.split_whitespace().collect::<Vec<_>>().join(" ");

    // A label can hide inside quotes and quotes behind a full stop, so peel
    // all three until none of them changes anything.
    loop {
        let peeled = strip_wrapper(strip_label(title.trim_start_matches('#').trim()))
            .trim_end_matches(['.', '。'])
            .trim();
        if peeled == title {
            break;
        }
        title = peeled.to_string();
    }

    let title: String = title.chars().take(TITLE_CHARS).collect();
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_string())
}

fn strip_label(title: &str) -> &str {
    const LABELS: [&str; 2] = ["title", "タイトル"];
    for label in LABELS {
        let Some(head) = title.get(..label.len()) else {
            continue;
        };
        if !head.eq_ignore_ascii_case(label) {
            continue;
        }
        if let Some(rest) = title[label.len()..].trim_start().strip_prefix([':', '：']) {
            return rest.trim_start();
        }
    }
    title
}

fn strip_wrapper(title: &str) -> &str {
    const WRAPPERS: [(&str, &str); 10] = [
        ("\"", "\""),
        ("'", "'"),
        ("`", "`"),
        ("**", "**"),
        ("__", "__"),
        ("“", "”"),
        ("‘", "’"),
        ("「", "」"),
        ("『", "』"),
        ("[", "]"),
    ];
    for (open, close) in WRAPPERS {
        if let Some(inner) = title
            .strip_prefix(open)
            .and_then(|rest| rest.strip_suffix(close))
        {
            return inner.trim();
        }
    }
    title
}

/// Run `command` as a one-shot titling call: the prompt for `request` goes to
/// its stdin and its stdout is the reply. `Ok(None)` when there is nothing to
/// name or the reply holds no title; an error when the call itself failed.
pub(crate) async fn generate(
    mut command: Command,
    request: &str,
) -> Result<Option<SessionName>, ExecutorError> {
    if request.trim().is_empty() {
        return Ok(None);
    }

    let mut child = command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("titling process missing stdin"))?;
    stdin.write_all(prompt(request).as_bytes()).await?;
    // Closing the pipe is what tells the CLI the prompt is complete.
    drop(stdin);

    // Dropping the wait on timeout drops the child, which kills it.
    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::TimedOut, "titling process timed out")
        })??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason: String = stderr.trim().chars().take(300).collect();
        return Err(std::io::Error::other(format!(
            "titling process exited with {}: {reason}",
            output.status
        ))
        .into());
    }
    Ok(parse(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_carries_the_instructions_and_the_head_of_the_request() {
        let text = prompt("  fix the login bug  ");
        assert!(text.starts_with(INSTRUCTIONS));
        assert!(text.contains(&format!("Icons: {}", TASK_ICONS.join(" "))));
        assert!(text.ends_with("<first_request>\nfix the login bug\n</first_request>\n"));

        let long = prompt(&"あ".repeat(REQUEST_CHARS + 500));
        assert_eq!(long.matches('あ').count(), REQUEST_CHARS);
    }

    #[test]
    fn sanitize_keeps_a_clean_title_as_is() {
        assert_eq!(
            sanitize("login.tsのリフレッシュトークン修正とテスト追加\n").as_deref(),
            Some("login.tsのリフレッシュトークン修正とテスト追加")
        );
    }

    #[test]
    fn sanitize_peels_labels_quotes_and_trailing_punctuation_in_any_nesting() {
        for reply in [
            "Title: \"SQLite WAL concurrent readers\"",
            "\"Title: SQLite WAL concurrent readers\".",
            "## **SQLite WAL concurrent readers**",
            "`SQLite WAL concurrent readers`.",
            "TITLE：SQLite WAL concurrent readers",
        ] {
            assert_eq!(
                sanitize(reply).as_deref(),
                Some("SQLite WAL concurrent readers"),
                "reply: {reply}"
            );
        }
        assert_eq!(
            sanitize("タイトル：「サイドバーの名前を直す」。").as_deref(),
            Some("サイドバーの名前を直す")
        );
    }

    #[test]
    fn sanitize_takes_the_first_line_and_collapses_whitespace() {
        assert_eq!(
            sanitize("\n\n  Fix   login\tbug  \nHere is why I chose it.").as_deref(),
            Some("Fix login bug")
        );
    }

    #[test]
    fn sanitize_leaves_a_title_that_only_starts_with_a_label_word() {
        assert_eq!(
            sanitize("Title bar spacing fix").as_deref(),
            Some("Title bar spacing fix")
        );
    }

    #[test]
    fn sanitize_caps_the_length_on_a_character_boundary() {
        let title = sanitize(&"あ".repeat(TITLE_CHARS + 20)).unwrap();
        assert_eq!(title.chars().count(), TITLE_CHARS);
    }

    #[test]
    fn sanitize_rejects_a_reply_with_no_title_in_it() {
        assert_eq!(sanitize(""), None);
        assert_eq!(sanitize("  \n\t\n"), None);
        assert_eq!(sanitize("\"\"."), None);
    }

    #[test]
    fn parse_reads_the_title_then_the_icon() {
        assert_eq!(
            parse("ログイン画面の不具合修正\nbug\n"),
            Some(SessionName {
                title: "ログイン画面の不具合修正".into(),
                icon: Some("bug".into())
            })
        );
    }

    #[test]
    fn parse_peels_the_icon_label_quotes_and_case() {
        for reply in [
            "Deploy pipeline\nIcon: rocket",
            "Deploy pipeline\n\n`Rocket`.",
            "Deploy pipeline\nアイコン：「rocket」",
            "Deploy pipeline\n**icon: ROCKET**",
        ] {
            assert_eq!(
                parse(reply).and_then(|name| name.icon).as_deref(),
                Some("rocket"),
                "reply: {reply}"
            );
        }
    }

    #[test]
    fn parse_keeps_the_title_when_the_icon_is_missing_or_unknown() {
        for reply in ["Deploy pipeline", "Deploy pipeline\nspaceship", "Deploy pipeline\nicon:"] {
            assert_eq!(
                parse(reply),
                Some(SessionName {
                    title: "Deploy pipeline".into(),
                    icon: None
                }),
                "reply: {reply}"
            );
        }
        assert_eq!(parse("\n  \n"), None);
    }

    #[test]
    fn the_icon_list_has_48_distinct_names() {
        let mut names = TASK_ICONS.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 48);
        assert!(names.iter().all(|name| name.chars().all(|c| c.is_ascii_lowercase())));
    }

    #[cfg(unix)]
    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn generate_feeds_the_prompt_and_cleans_the_reply() {
        // Echo a decorated title only when the request arrived on stdin.
        let command = shell(
            "grep -q 'fix the login bug' && printf 'Title: \"Login bug fix\"\\nIcon: bug\\n'",
        );
        let name = generate(command, "fix the login bug").await.unwrap();
        assert_eq!(
            name,
            Some(SessionName {
                title: "Login bug fix".into(),
                icon: Some("bug".into())
            })
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn generate_reports_a_failed_call() {
        let command = shell("cat >/dev/null; echo 'not logged in' >&2; exit 3");
        let error = generate(command, "fix the login bug").await.unwrap_err();
        assert!(error.to_string().contains("not logged in"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn generate_skips_the_call_when_there_is_nothing_to_name() {
        // The command would fail if it ran.
        let title = generate(shell("exit 1"), "  \n").await.unwrap();
        assert_eq!(title, None);
    }
}
