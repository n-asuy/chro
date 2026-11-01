//! `chro session ...`

use std::{io::Read, process::ExitCode, time::Duration};

use clap::{Subcommand, ValueEnum};
use server_contract::{
    api::*,
    routes::{self, NoBody},
    ErrorBody, ErrorCode,
};

use super::{
    client::Client,
    output::{finish, Failure, Mode},
    project::cwd_project_selector,
};

#[derive(Subcommand, Debug)]
pub enum SessionCommand {
    /// List sessions, most recently updated first
    List {
        /// Only sessions of this project (slug, id, or path:<dir>)
        #[arg(long)]
        project: Option<String>,
        /// Only sessions in this state
        #[arg(long, value_enum)]
        state: Option<StateArg>,
        /// Only sessions whose latest outcome is this status
        #[arg(long)]
        status: Option<String>,
        /// How many sessions to show
        #[arg(long, default_value_t = DEFAULT_SESSION_LIMIT)]
        limit: u32,
    },
    /// Show one session: state, branch, note, queue, parent and children
    Show {
        /// self, parent, a slug or slug prefix, or an id
        session: String,
    },
    /// Start a new session and its first turn
    New {
        /// The task for the agent; `-` reads it from stdin
        #[arg(long)]
        prompt: String,
        /// Project to run in (slug, id, or path:<dir>); defaults to the
        /// repository or folder of the current directory
        #[arg(long)]
        project: Option<String>,
        #[command(flatten)]
        agent: AgentArgs,
        /// Title instead of one derived from the prompt
        #[arg(long)]
        title: Option<String>,
        /// Attach another session as context (repeatable)
        #[arg(long = "ref", value_name = "SESSION")]
        refs: Vec<String>,
        /// Create the session without starting a turn
        #[arg(long)]
        no_start: bool,
    },
    /// Hand part of a session's work to a new session; the delegating session
    /// is woken with the results once every session it delegated has finished
    Delegate {
        /// The brief for the new session; `-` reads it from stdin
        #[arg(long)]
        prompt: String,
        /// The delegating session
        #[arg(long, default_value = "self")]
        from: String,
        #[command(flatten)]
        agent: AgentArgs,
    },
    /// Branch a session from its latest finished turn into a new session
    Fork {
        session: String,
        /// First message of the fork; without one the fork waits idle
        #[arg(long)]
        prompt: Option<String>,
    },
    /// Send a message: starts a turn when the session is idle, otherwise
    /// queues it behind the current turn
    Send {
        session: String,
        /// The message; `-` reads it from stdin
        #[arg(long)]
        prompt: String,
        /// Fail with session_busy instead of queueing behind a running turn
        #[arg(long)]
        no_queue: bool,
    },
    /// Wait until a session is idle, needs input, or either
    Wait {
        session: String,
        /// idle: no turn running and nothing queued; input: suspended on an
        /// approval or question; settled: whichever comes first
        #[arg(long = "for", value_enum)]
        condition: WaitArg,
        /// Give up after this long, e.g. 90s, 30m, 2h (at most 2h)
        #[arg(long, default_value = "30m", value_parser = parse_duration)]
        timeout: Duration,
    },
    /// Read the conversation; pass a previous next_cursor as --since to read
    /// only what came after it
    Read {
        session: String,
        #[arg(long)]
        since: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long, value_enum, default_value_t = ReadFormat::Entries)]
        format: ReadFormat,
    },
    /// Stop the running turn and discard queued messages
    Cancel { session: String },
    /// Withdraw one queued message before it becomes a turn
    Unqueue {
        session: String,
        /// Id of the queued message (as listed by `session show`), or a unique prefix of 3+ characters
        message: String,
    },
    /// Change a session's title, status, or note
    Set {
        session: String,
        #[arg(long)]
        title: Option<String>,
        /// pending, in_progress, completed, failed, or cancelled
        #[arg(long)]
        status: Option<String>,
        /// Short status line shown on the session's row; "" clears it
        #[arg(long)]
        note: Option<String>,
    },
    /// List what a session references (or, with --inbound, what references it)
    Refs {
        session: String,
        #[arg(long)]
        inbound: bool,
    },
    /// Show what merging the session would bring into its target branch
    Diff { session: String },
    /// Merge the session's branch into its target branch
    Merge {
        session: String,
        #[arg(short = 'm', long = "message")]
        message: Option<String>,
    },
    /// Rebase the session's branch onto a base branch
    Rebase {
        session: String,
        /// Defaults to the session's target branch
        #[arg(long)]
        onto: Option<String>,
    },
}

#[derive(clap::Args, Debug, Clone, Default)]
pub struct AgentArgs {
    /// claude, codex, or pi; defaults to the app's setting
    #[arg(long)]
    pub agent: Option<String>,
    /// Model id passed to the agent
    #[arg(long)]
    pub model: Option<String>,
    /// Reasoning effort: low, medium, high, xhigh, max, or ultra (per model)
    #[arg(long)]
    pub effort: Option<String>,
}

impl From<AgentArgs> for AgentChoice {
    fn from(args: AgentArgs) -> Self {
        AgentChoice {
            agent: args.agent,
            model: args.model,
            effort: args.effort,
        }
    }
}

#[derive(ValueEnum, Debug, Clone, Copy)]
pub enum StateArg {
    Idle,
    Running,
    AwaitingInput,
}

impl From<StateArg> for SessionState {
    fn from(arg: StateArg) -> Self {
        match arg {
            StateArg::Idle => SessionState::Idle,
            StateArg::Running => SessionState::Running,
            StateArg::AwaitingInput => SessionState::AwaitingInput,
        }
    }
}

#[derive(ValueEnum, Debug, Clone, Copy)]
pub enum WaitArg {
    Idle,
    Input,
    Settled,
}

impl From<WaitArg> for WaitFor {
    fn from(arg: WaitArg) -> Self {
        match arg {
            WaitArg::Idle => WaitFor::Idle,
            WaitArg::Input => WaitFor::Input,
            WaitArg::Settled => WaitFor::Settled,
        }
    }
}

#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadFormat {
    /// Structured entries with cursors
    Entries,
    /// The whole conversation as Markdown
    Markdown,
}

/// `90s`, `30m`, `2h`, or bare seconds.
pub(crate) fn parse_duration(raw: &str) -> Result<Duration, String> {
    let raw = raw.trim();
    let (number, unit) = match raw.find(|c: char| !c.is_ascii_digit()) {
        Some(split) => raw.split_at(split),
        None => (raw, "s"),
    };
    let value: u64 = number
        .parse()
        .map_err(|_| format!("'{raw}' is not a duration like 90s, 30m or 2h"))?;
    let seconds = match unit {
        "ms" => return Ok(Duration::from_millis(value)),
        "s" => value,
        "m" => value * 60,
        "h" => value * 3600,
        _ => return Err(format!("'{raw}' is not a duration like 90s, 30m or 2h")),
    };
    Ok(Duration::from_secs(seconds))
}

/// The prompt text, read from stdin when given as `-`.
fn prompt_text(raw: String) -> Result<String, ErrorBody> {
    if raw != "-" {
        return Ok(raw);
    }
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).map_err(|err| {
        ErrorBody::new(
            ErrorCode::Usage,
            format!("reading the prompt from stdin: {err}"),
        )
    })?;
    Ok(text)
}

pub(crate) fn run(
    command: SessionCommand,
    client: Result<Client, ErrorBody>,
    mode: Mode,
) -> ExitCode {
    let client = match client {
        Ok(client) => client,
        Err(err) => return super::output::fail(mode, err),
    };
    let c = &client;
    match command {
        SessionCommand::List {
            project,
            state,
            status,
            limit,
        } => {
            let mut query = vec![("limit", limit.to_string())];
            if let Some(project) = project {
                query.push(("project", project));
            }
            if let Some(state) = state {
                query.push(("state", SessionState::from(state).as_str().to_string()));
            }
            if let Some(status) = status {
                query.push(("status", status));
            }
            finish(
                mode,
                c.call(&routes::SESSIONS, &[], &query, None::<&NoBody>),
            )
        }
        SessionCommand::Show { session } => {
            finish(mode, c.call(&routes::SESSION, &[&session], &[], None))
        }
        SessionCommand::New {
            prompt,
            project,
            agent,
            title,
            refs,
            no_start,
        } => finish(
            mode,
            (|| {
                let body = NewSession {
                    project: match project {
                        Some(project) => project,
                        None => cwd_project_selector()?,
                    },
                    prompt: prompt_text(prompt)?,
                    title,
                    agent: agent.into(),
                    refs,
                    start: !no_start,
                };
                c.call(&routes::SESSION_CREATE, &[], &[], Some(&body))
            })(),
        ),
        SessionCommand::Delegate {
            prompt,
            from,
            agent,
        } => finish(
            mode,
            prompt_text(prompt)
                .map_err(Failure::from)
                .and_then(|prompt| {
                    c.call(
                        &routes::SESSION_DELEGATE,
                        &[&from],
                        &[],
                        Some(&Delegate {
                            prompt,
                            agent: agent.into(),
                        }),
                    )
                }),
        ),
        SessionCommand::Fork { session, prompt } => finish(
            mode,
            prompt
                .map(prompt_text)
                .transpose()
                .map_err(Failure::from)
                .and_then(|prompt| {
                    c.call(
                        &routes::SESSION_FORK,
                        &[&session],
                        &[],
                        Some(&Fork { prompt }),
                    )
                }),
        ),
        SessionCommand::Send {
            session,
            prompt,
            no_queue,
        } => finish(
            mode,
            prompt_text(prompt)
                .map_err(Failure::from)
                .and_then(|prompt| {
                    c.call(
                        &routes::SESSION_SEND,
                        &[&session],
                        &[],
                        Some(&SendMessage {
                            prompt,
                            queue: !no_queue,
                        }),
                    )
                }),
        ),
        SessionCommand::Wait {
            session,
            condition,
            timeout,
        } => {
            let timeout = timeout.min(Duration::from_millis(MAX_WAIT_MS));
            let query = [
                ("for", WaitFor::from(condition).as_str().to_string()),
                ("timeout_ms", timeout.as_millis().to_string()),
            ];
            finish(
                mode,
                c.call_waiting(&routes::SESSION_WAIT, &[&session], &query, timeout),
            )
        }
        SessionCommand::Read {
            session,
            since,
            limit,
            format,
        } => match format {
            ReadFormat::Markdown => finish(
                mode,
                c.call(&routes::SESSION_TRANSCRIPT, &[&session], &[], None),
            ),
            ReadFormat::Entries => {
                let mut query = Vec::new();
                if let Some(since) = since {
                    query.push(("since", since));
                }
                if let Some(limit) = limit {
                    query.push(("limit", limit.to_string()));
                }
                finish(
                    mode,
                    c.call(&routes::SESSION_ENTRIES, &[&session], &query, None),
                )
            }
        },
        SessionCommand::Cancel { session } => finish(
            mode,
            c.call(&routes::SESSION_CANCEL, &[&session], &[], None),
        ),
        SessionCommand::Unqueue { session, message } => finish(
            mode,
            c.call(&routes::SESSION_UNQUEUE, &[&session, &message], &[], None),
        ),
        SessionCommand::Set {
            session,
            title,
            status,
            note,
        } => {
            let body = UpdateSession {
                title,
                status,
                note,
            };
            if body == UpdateSession::default() {
                return super::output::fail(
                    mode,
                    ErrorBody::new(
                        ErrorCode::Usage,
                        "nothing to change: pass --title, --status, or --note",
                    ),
                );
            }
            finish(
                mode,
                c.call(&routes::SESSION_UPDATE, &[&session], &[], Some(&body)),
            )
        }
        SessionCommand::Refs { session, inbound } => {
            let direction = if inbound { "inbound" } else { "outbound" };
            finish(
                mode,
                c.call(
                    &routes::SESSION_REFS,
                    &[&session],
                    &[("direction", direction.to_string())],
                    None,
                ),
            )
        }
        SessionCommand::Diff { session } => {
            finish(mode, c.call(&routes::SESSION_DIFF, &[&session], &[], None))
        }
        SessionCommand::Merge { session, message } => finish(
            mode,
            c.call(
                &routes::SESSION_MERGE,
                &[&session],
                &[],
                Some(&Merge { message }),
            ),
        ),
        SessionCommand::Rebase { session, onto } => finish(
            mode,
            c.call(
                &routes::SESSION_REBASE,
                &[&session],
                &[],
                Some(&Rebase { onto }),
            ),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_accept_the_units_people_type() {
        assert_eq!(parse_duration("90s").unwrap(), Duration::from_secs(90));
        assert_eq!(parse_duration("30m").unwrap(), Duration::from_secs(1800));
        assert_eq!(parse_duration("2h").unwrap(), Duration::from_secs(7200));
        assert_eq!(parse_duration("45").unwrap(), Duration::from_secs(45));
        assert_eq!(parse_duration("500ms").unwrap(), Duration::from_millis(500));
        assert!(parse_duration("soon").is_err());
        assert!(parse_duration("5d").is_err());
    }
}
