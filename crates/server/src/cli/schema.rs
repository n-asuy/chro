//! `chro schema`: the command line described as data, generated from the same
//! definitions that parse it, so it cannot drift from what the binary accepts.

use clap::{Arg, ArgAction, Command, CommandFactory};
use serde::Serialize;
use server_contract::{ErrorCode, CONTRACT_REV};

use super::output::Human;
use crate::args::TerminalCli;

#[derive(Debug, Serialize)]
pub(crate) struct Schema {
    pub contract_rev: String,
    pub commands: Vec<CommandSchema>,
    pub selectors: Selectors,
    pub errors: Vec<ErrorSchema>,
    pub output: &'static str,
}

#[derive(Debug, Serialize)]
pub(crate) struct CommandSchema {
    /// Words after `chro`, e.g. `["session", "send"]`.
    pub path: Vec<String>,
    pub about: String,
    pub args: Vec<ArgSchema>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ArgSchema {
    pub name: String,
    /// `--flag` form, absent for positionals.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long: Option<String>,
    pub positional: bool,
    pub required: bool,
    pub takes_value: bool,
    pub repeatable: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    pub help: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct Selectors {
    pub session: Vec<&'static str>,
    pub project: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ErrorSchema {
    pub code: ErrorCode,
    pub exit: u8,
}

fn arg_schema(arg: &Arg) -> ArgSchema {
    let takes_value = matches!(arg.get_action(), ArgAction::Set | ArgAction::Append);
    ArgSchema {
        name: arg.get_id().to_string(),
        long: arg.get_long().map(|long| format!("--{long}")),
        positional: arg.is_positional(),
        required: arg.is_required_set(),
        takes_value,
        repeatable: matches!(arg.get_action(), ArgAction::Append),
        values: arg
            .get_possible_values()
            .iter()
            .map(|value| value.get_name().to_string())
            .collect(),
        default: arg
            .get_default_values()
            .first()
            .map(|value| value.to_string_lossy().into_owned()),
        help: arg.get_help().map(ToString::to_string).unwrap_or_default(),
    }
}

fn walk(command: &Command, path: &mut Vec<String>, out: &mut Vec<CommandSchema>) {
    let subcommands: Vec<_> = command
        .get_subcommands()
        .filter(|sub| sub.get_name() != "help")
        .collect();
    if subcommands.is_empty() {
        out.push(CommandSchema {
            path: path.clone(),
            about: command.get_about().map(ToString::to_string).unwrap_or_default(),
            args: command
                .get_arguments()
                .filter(|arg| !matches!(arg.get_id().as_str(), "help" | "version"))
                .filter(|arg| !arg.is_global_set())
                .map(arg_schema)
                .collect(),
        });
        return;
    }
    for sub in subcommands {
        path.push(sub.get_name().to_string());
        walk(sub, path, out);
        path.pop();
    }
}

pub(crate) fn schema() -> Schema {
    let root = TerminalCli::command();
    let mut commands = Vec::new();
    walk(&root, &mut Vec::new(), &mut commands);
    Schema {
        contract_rev: CONTRACT_REV.to_string(),
        commands,
        selectors: Selectors {
            session: vec!["self", "parent", "<slug>", "<slug prefix, 3+ chars>", "<id>"],
            project: vec!["<slug>", "<slug prefix, 3+ chars>", "<id>", "path:<absolute dir>"],
        },
        errors: ErrorCode::ALL
            .iter()
            .map(|code| ErrorSchema {
                code: *code,
                exit: code.exit_code(),
            })
            .collect(),
        output: "stdout is one JSON envelope {ok, result|error, meta} unless it is a terminal; --json and --human override",
    }
}

impl Human for Schema {
    fn human(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_leaf_command_is_listed_once() {
        let schema = schema();
        let paths: Vec<String> = schema.commands.iter().map(|c| c.path.join(" ")).collect();
        for expected in ["status", "session send", "session wait", "approval respond", "skill install"] {
            assert!(paths.contains(&expected.to_string()), "{expected} missing from {paths:?}");
        }
        let mut deduped = paths.clone();
        deduped.dedup();
        assert_eq!(deduped.len(), paths.len());
    }

    #[test]
    fn flags_carry_their_shape() {
        let schema = schema();
        let wait = schema
            .commands
            .iter()
            .find(|c| c.path == ["session", "wait"])
            .unwrap();
        let condition = wait.args.iter().find(|a| a.long.as_deref() == Some("--for")).unwrap();
        assert!(condition.required);
        assert_eq!(condition.values, vec!["idle", "input", "settled"]);
        let session = wait.args.iter().find(|a| a.positional).unwrap();
        assert_eq!(session.name, "session");
    }

    #[test]
    fn errors_list_every_code_with_its_exit() {
        assert_eq!(schema().errors.len(), ErrorCode::ALL.len());
    }
}
