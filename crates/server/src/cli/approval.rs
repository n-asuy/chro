//! `chro approval ...`

use std::{collections::BTreeMap, process::ExitCode};

use clap::Subcommand;
use server_contract::{
    api::{Decision, Respond},
    routes::{self, NoBody},
    ErrorBody, ErrorCode,
};

use super::{
    client::Client,
    output::{fail, finish, Failure, Mode},
};

#[derive(Subcommand, Debug)]
pub enum ApprovalCommand {
    /// List pending approvals
    List {
        /// Only approvals of this session
        #[arg(long)]
        session: Option<String>,
    },
    /// Show an approval in full, including the tool input and, for a
    /// question, its options
    Show { approval: String },
    /// Answer an approval
    Respond {
        approval: String,
        #[arg(long, conflicts_with = "deny")]
        approve: bool,
        #[arg(long)]
        deny: bool,
        /// Why it was denied, shown to the agent
        #[arg(long, requires = "deny")]
        reason: Option<String>,
        /// Answer a question as "question=option" (repeatable); implies approve
        #[arg(
            long = "answer",
            value_name = "QUESTION=OPTION",
            conflicts_with = "deny"
        )]
        answers: Vec<String>,
    },
}

fn respond_body(
    approve: bool,
    deny: bool,
    reason: Option<String>,
    answers: Vec<String>,
) -> Result<Respond, ErrorBody> {
    let mut parsed = BTreeMap::new();
    for answer in answers {
        let (question, option) = answer.split_once('=').ok_or_else(|| {
            ErrorBody::new(
                ErrorCode::Usage,
                format!("--answer '{answer}' must look like \"question=option\""),
            )
        })?;
        parsed.insert(question.trim().to_string(), option.trim().to_string());
    }
    let decision = match (approve || !parsed.is_empty(), deny) {
        (true, false) => Decision::Approve,
        (false, true) => Decision::Deny,
        _ => {
            return Err(ErrorBody::new(
                ErrorCode::Usage,
                "choose one of --approve, --deny, or --answer",
            ))
        }
    };
    Ok(Respond {
        decision,
        reason,
        answers: parsed,
    })
}

pub(crate) fn run(
    command: ApprovalCommand,
    client: Result<Client, ErrorBody>,
    mode: Mode,
) -> ExitCode {
    let client = match client {
        Ok(client) => client,
        Err(err) => return fail(mode, err),
    };
    match command {
        ApprovalCommand::List { session } => {
            let query: Vec<_> = session.into_iter().map(|s| ("session", s)).collect();
            finish(
                mode,
                client.call(&routes::APPROVALS, &[], &query, None::<&NoBody>),
            )
        }
        ApprovalCommand::Show { approval } => finish(
            mode,
            client.call(&routes::APPROVAL, &[&approval], &[], None),
        ),
        ApprovalCommand::Respond {
            approval,
            approve,
            deny,
            reason,
            answers,
        } => finish(
            mode,
            respond_body(approve, deny, reason, answers)
                .map_err(Failure::from)
                .and_then(|body| {
                    client.call(&routes::APPROVAL_RESPOND, &[&approval], &[], Some(&body))
                }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_imply_approval_and_parse_question_option_pairs() {
        let body = respond_body(false, false, None, vec!["Which db? = sqlite".into()]).unwrap();
        assert_eq!(body.decision, Decision::Approve);
        assert_eq!(
            body.answers.get("Which db?").map(String::as_str),
            Some("sqlite")
        );
    }

    #[test]
    fn a_decision_is_required() {
        assert_eq!(
            respond_body(false, false, None, vec![]).unwrap_err().code,
            ErrorCode::Usage
        );
        assert_eq!(
            respond_body(false, false, None, vec!["no equals".into()])
                .unwrap_err()
                .code,
            ErrorCode::Usage
        );
    }
}
