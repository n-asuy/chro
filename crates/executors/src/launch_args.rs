//! Extra launch arguments a user sets for an agent CLI.
//!
//! The arguments are one shell-style string per agent, appended after the
//! flags chro passes itself. Flags chro already sets are refused: chro reads
//! the CLI's structured output and drives its session state, so a user value
//! for one of them would either be ignored or break the run silently.
//!
//! The question tool has its own on/off setting, so turning it off through
//! the arguments (`--disallowedTools AskUserQuestion`) is refused as well:
//! one setting, one place.

use thiserror::Error;

use crate::{
    command::split_command_line,
    executors::{BaseCodingAgent, CodingAgent, claude, codex, pi},
};

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum LaunchArgsError {
    #[error("launch arguments could not be parsed (unbalanced quotes?)")]
    Unparseable,
    #[error("`{flag}` is set by chro and cannot be passed as a launch argument")]
    ReservedFlag { flag: String },
    #[error("the question tool is turned off with its own setting, not with launch arguments")]
    QuestionToolFlag,
}

/// Whether the agent has a question tool chro can turn off.
pub fn supports_question_tool(agent: BaseCodingAgent) -> bool {
    matches!(agent, BaseCodingAgent::ClaudeCode)
}

/// Claude flags whose values name tools to disable.
const CLAUDE_DISALLOWED_TOOLS_FLAGS: &[&str] = &["--disallowedTools", "--disallowed-tools"];

/// Whether `tokens` disable Claude's question tool through `--disallowedTools`.
/// The flag takes one or more values, separated by spaces or commas, up to
/// the next flag; a value may carry a permission pattern (`Tool(...)`).
fn disables_question_tool(tokens: &[String]) -> bool {
    let names_question_tool = |value: &str| {
        value
            .split([',', ' '])
            .map(|name| name.split('(').next().unwrap_or(name).trim())
            .any(|name| name == claude::QUESTION_TOOL)
    };
    let mut in_values = false;
    for token in tokens {
        if let Some((flag, value)) = token.split_once('=')
            && CLAUDE_DISALLOWED_TOOLS_FLAGS.contains(&flag)
        {
            if names_question_tool(value) {
                return true;
            }
            in_values = false;
            continue;
        }
        if CLAUDE_DISALLOWED_TOOLS_FLAGS.contains(&token.as_str()) {
            in_values = true;
        } else if token.starts_with('-') {
            in_values = false;
        } else if in_values && names_question_tool(token) {
            return true;
        }
    }
    false
}

/// Flags chro sets on the agent's command line itself.
pub fn reserved_launch_flags(agent: BaseCodingAgent) -> &'static [&'static str] {
    match agent {
        BaseCodingAgent::ClaudeCode => claude::RESERVED_LAUNCH_FLAGS,
        BaseCodingAgent::Codex => codex::RESERVED_LAUNCH_FLAGS,
        BaseCodingAgent::Pi => pi::RESERVED_LAUNCH_FLAGS,
    }
}

/// Validate a user's launch arguments and return the string to store.
/// Surrounding whitespace is dropped; an empty result means "none".
pub fn validate_launch_args(agent: BaseCodingAgent, raw: &str) -> Result<String, LaunchArgsError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let tokens = split_command_line(trimmed).map_err(|_| LaunchArgsError::Unparseable)?;
    let reserved = reserved_launch_flags(agent);
    let hit = tokens.iter().find_map(|token| {
        let name = token
            .split_once('=')
            .map_or(token.as_str(), |(name, _)| name);
        reserved.contains(&name).then(|| name.to_string())
    });
    if let Some(flag) = hit {
        return Err(LaunchArgsError::ReservedFlag { flag });
    }
    if supports_question_tool(agent) && disables_question_tool(&tokens) {
        return Err(LaunchArgsError::QuestionToolFlag);
    }
    Ok(trimmed.to_string())
}

impl CodingAgent {
    /// Append the user's launch arguments after any profile-level ones.
    ///
    /// `additional_params` entries are joined with spaces and shell-split when
    /// the command is built, so the user's string is kept whole here; splitting
    /// it now would break quoted values apart.
    pub fn with_launch_args(mut self, args: &str) -> Self {
        let args = args.trim();
        if args.is_empty() {
            return self;
        }
        let cmd = match &mut self {
            CodingAgent::ClaudeCode(agent) => &mut agent.cmd,
            CodingAgent::Codex(agent) => &mut agent.cmd,
            CodingAgent::Pi(agent) => &mut agent.cmd,
        };
        cmd.additional_params
            .get_or_insert_with(Vec::new)
            .push(args.to_string());
        self
    }

    /// Turn the agent's question tool off (it is on unless disabled). A no-op
    /// for agents without one (see [`supports_question_tool`]).
    pub fn with_question_tool(mut self, enabled: bool) -> Self {
        if let CodingAgent::ClaudeCode(agent) = &mut self {
            agent.disable_question_tool = !enabled;
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ClaudeCode,
        command::{CmdOverrides, CommandBuilder, apply_overrides},
    };

    fn built_args(agent: &CodingAgent) -> Vec<String> {
        let cmd: &CmdOverrides = match agent {
            CodingAgent::ClaudeCode(agent) => &agent.cmd,
            CodingAgent::Codex(agent) => &agent.cmd,
            CodingAgent::Pi(agent) => &agent.cmd,
        };
        apply_overrides(CommandBuilder::new("agent"), cmd)
            .expect("overrides apply")
            .params
            .unwrap_or_default()
    }

    #[test]
    fn empty_input_means_no_arguments() {
        assert_eq!(
            validate_launch_args(BaseCodingAgent::ClaudeCode, "  \n "),
            Ok(String::new())
        );
    }

    #[test]
    fn accepts_and_trims_unreserved_arguments() {
        assert_eq!(
            validate_launch_args(
                BaseCodingAgent::ClaudeCode,
                "  --append-system-prompt \"Ask with AskUserQuestion.\"  "
            ),
            Ok("--append-system-prompt \"Ask with AskUserQuestion.\"".to_string())
        );
    }

    #[test]
    fn refuses_flags_chro_sets_itself() {
        assert_eq!(
            validate_launch_args(BaseCodingAgent::ClaudeCode, "--model opus"),
            Err(LaunchArgsError::ReservedFlag {
                flag: "--model".to_string()
            })
        );
        assert_eq!(
            validate_launch_args(BaseCodingAgent::ClaudeCode, "--output-format=text"),
            Err(LaunchArgsError::ReservedFlag {
                flag: "--output-format".to_string()
            })
        );
        assert_eq!(
            validate_launch_args(BaseCodingAgent::Pi, "--thinking high"),
            Err(LaunchArgsError::ReservedFlag {
                flag: "--thinking".to_string()
            })
        );
    }

    #[test]
    fn reserved_flags_are_per_agent() {
        // Codex receives its model over the app-server protocol, not `--model`.
        assert!(validate_launch_args(BaseCodingAgent::Codex, "-c model_verbosity=low").is_ok());
        assert!(validate_launch_args(BaseCodingAgent::Pi, "--model x").is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn refuses_unbalanced_quotes() {
        assert_eq!(
            validate_launch_args(BaseCodingAgent::ClaudeCode, "--append-system-prompt \"oops"),
            Err(LaunchArgsError::Unparseable)
        );
    }

    #[test]
    fn refuses_turning_the_question_tool_off_through_arguments() {
        for args in [
            "--disallowedTools AskUserQuestion",
            "--disallowedTools Bash AskUserQuestion --verbose-x",
            "--disallowedTools Bash,AskUserQuestion",
            "--disallowed-tools=AskUserQuestion",
            "--disallowedTools \"AskUserQuestion(*)\"",
        ] {
            assert_eq!(
                validate_launch_args(BaseCodingAgent::ClaudeCode, args),
                Err(LaunchArgsError::QuestionToolFlag),
                "{args}"
            );
        }
    }

    #[test]
    fn allows_other_disallowed_tools_and_prompts_that_mention_the_tool() {
        for args in [
            "--disallowedTools Bash",
            "--disallowedTools Bash --append-system-prompt \"Ask with AskUserQuestion.\"",
            "--append-system-prompt AskUserQuestion",
        ] {
            assert!(
                validate_launch_args(BaseCodingAgent::ClaudeCode, args).is_ok(),
                "{args}"
            );
        }
    }

    #[test]
    fn only_claude_has_a_question_tool_setting() {
        assert!(supports_question_tool(BaseCodingAgent::ClaudeCode));
        assert!(!supports_question_tool(BaseCodingAgent::Codex));
        assert!(!supports_question_tool(BaseCodingAgent::Pi));
        let agent = CodingAgent::ClaudeCode(ClaudeCode::default()).with_question_tool(false);
        let CodingAgent::ClaudeCode(claude) = agent else {
            unreachable!()
        };
        assert!(claude.disable_question_tool);
    }

    #[test]
    fn launch_args_keep_quoted_values_whole() {
        let agent = CodingAgent::ClaudeCode(ClaudeCode::default())
            .with_launch_args("--append-system-prompt \"Ask with AskUserQuestion.\"");
        assert_eq!(
            built_args(&agent),
            vec!["--append-system-prompt", "Ask with AskUserQuestion."]
        );
    }

    #[test]
    fn launch_args_follow_profile_arguments() {
        let mut claude = ClaudeCode::default();
        claude.cmd.additional_params = Some(vec!["--from-profile".to_string()]);
        let agent = CodingAgent::ClaudeCode(claude).with_launch_args("--from-user");
        assert_eq!(built_args(&agent), vec!["--from-profile", "--from-user"]);
    }

    #[test]
    fn blank_launch_args_leave_the_agent_unchanged() {
        let agent = CodingAgent::ClaudeCode(ClaudeCode::default());
        assert_eq!(agent.clone().with_launch_args("   "), agent);
    }
}
