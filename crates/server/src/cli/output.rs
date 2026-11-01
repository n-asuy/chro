//! How a command reports: one JSON envelope for programs, plain text for
//! people, and an exit code derived from the error code either way.

use std::{
    io::{IsTerminal, Write},
    process::ExitCode,
};

use serde::Serialize;
use server_contract::{Envelope, ErrorBody, Meta};

use super::client::Answer;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Json,
    Human,
}

impl Mode {
    /// Explicit flags win; otherwise people get text on a terminal and
    /// programs get JSON through a pipe.
    pub fn choose(json: bool, human: bool, stdout_is_terminal: bool) -> Self {
        if json {
            Mode::Json
        } else if human || stdout_is_terminal {
            Mode::Human
        } else {
            Mode::Json
        }
    }

    pub fn detect(json: bool, human: bool) -> Self {
        Self::choose(json, human, std::io::stdout().is_terminal())
    }
}

/// Plain-text rendering of a result for people.
pub(crate) trait Human {
    fn human(&self) -> String;
}

/// A failed command: the error and the meta of whoever produced it, the
/// server when it answered, otherwise this CLI.
#[derive(Debug)]
pub(crate) struct Failure {
    pub error: ErrorBody,
    pub meta: Meta,
}

impl From<ErrorBody> for Failure {
    fn from(error: ErrorBody) -> Self {
        Self {
            error,
            meta: Meta::local(),
        }
    }
}

pub(crate) fn finish<T: Serialize + Human, E: Into<Failure>>(
    mode: Mode,
    outcome: Result<Answer<T>, E>,
) -> ExitCode {
    match outcome {
        Ok(answer) => {
            match mode {
                Mode::Json => print_json(&Envelope::success(answer.result, answer.meta)),
                Mode::Human => {
                    let text = answer.result.human();
                    if !text.is_empty() {
                        println!("{}", text.trim_end());
                    }
                }
            }
            ExitCode::SUCCESS
        }
        Err(failure) => fail(mode, failure),
    }
}

pub(crate) fn fail(mode: Mode, failure: impl Into<Failure>) -> ExitCode {
    let Failure { error, meta } = failure.into();
    let code = ExitCode::from(error.code.exit_code());
    match mode {
        Mode::Human => eprint!("{}", human_error(&error)),
        Mode::Json => print_json(&Envelope::<()>::failure(error, meta)),
    }
    code
}

pub(crate) fn human_error(error: &ErrorBody) -> String {
    let mut out = format!("error[{}]: {}\n", error.code, error.message);
    if !error.candidates.is_empty() {
        out.push_str(&format!("  matches: {}\n", error.candidates.join(", ")));
    }
    for next in &error.next {
        out.push_str(&format!("  next: {next}\n"));
    }
    out
}

fn print_json(value: &impl Serialize) {
    let mut stdout = std::io::stdout().lock();
    let _ = serde_json::to_writer_pretty(&mut stdout, value);
    let _ = writeln!(stdout);
}

#[cfg(test)]
mod tests {
    use super::*;
    use server_contract::ErrorCode;

    #[test]
    fn pipes_get_json_and_terminals_get_text_unless_told_otherwise() {
        assert_eq!(Mode::choose(false, false, false), Mode::Json);
        assert_eq!(Mode::choose(false, false, true), Mode::Human);
        assert_eq!(Mode::choose(true, false, true), Mode::Json);
        assert_eq!(Mode::choose(false, true, false), Mode::Human);
    }

    #[test]
    fn human_errors_name_the_code_and_the_next_step() {
        let error = ErrorBody::new(ErrorCode::SessionBusy, "busy")
            .with_next("chro session wait ab12 --for idle");
        assert_eq!(
            human_error(&error),
            "error[session_busy]: busy\n  next: chro session wait ab12 --for idle\n"
        );
    }
}
