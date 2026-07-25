use clap::Subcommand;

use super::client::{self, ServerClient};

#[derive(Subcommand, Debug)]
pub enum ApprovalCommand {
    /// List pending approvals, optionally filtered to one task
    List {
        /// Only show approvals for this task ID or slug
        #[arg(long, value_name = "TASK")]
        task: Option<String>,
    },

    /// Show a pending approval in full, including the tool input (and, for
    /// AskUserQuestion, the question text and options)
    Show {
        /// Approval ID
        id: String,
    },

    /// Respond to a pending approval
    Respond {
        /// Approval ID
        id: String,
        /// Approve the request
        #[arg(long, conflicts_with = "deny")]
        approve: bool,
        /// Deny the request
        #[arg(long)]
        deny: bool,
        /// Reason for denial
        #[arg(long)]
        reason: Option<String>,
        /// Answer for an AskUserQuestion prompt, as "question=option". Repeat
        /// for multiple questions. Implies approval.
        #[arg(long = "answer", value_name = "Q=OPTION")]
        answers: Vec<String>,
    },
}

pub fn run(cmd: &ApprovalCommand, client: &ServerClient) -> Result<(), client::ClientError> {
    match cmd {
        ApprovalCommand::List { task } => list(client, task.as_deref()),
        ApprovalCommand::Show { id } => show(client, id),
        ApprovalCommand::Respond {
            id,
            approve,
            deny,
            reason,
            answers,
        } => respond(client, id, *approve, *deny, reason.as_deref(), answers),
    }
}

fn list(client: &ServerClient, task: Option<&str>) -> Result<(), client::ClientError> {
    let resp = client.get("/rpc/approvals")?;
    let pending = resp
        .get("pending")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let rows: Vec<&serde_json::Value> = pending
        .iter()
        .filter(|p| match task {
            None => true,
            Some(t) => {
                p.get("task_slug").and_then(|v| v.as_str()) == Some(t)
                    || p.get("task_id").and_then(|v| v.as_str()) == Some(t)
            }
        })
        .collect();

    if rows.is_empty() {
        println!("No pending approvals.");
        return Ok(());
    }

    for p in rows {
        let approval_id = p.get("approval_id").and_then(|v| v.as_str()).unwrap_or("-");
        let tool = p.get("tool_name").and_then(|v| v.as_str()).unwrap_or("?");
        let task_label = p
            .get("task_slug")
            .and_then(|v| v.as_str())
            .or_else(|| p.get("task_id").and_then(|v| v.as_str()))
            .unwrap_or("-");
        println!("{approval_id:<38} {tool:<20} task:{task_label}");
    }

    Ok(())
}

fn show(client: &ServerClient, id: &str) -> Result<(), client::ClientError> {
    let resp = client.get(&format!("/rpc/approvals/{id}"))?;

    let status = resp
        .get("status")
        .and_then(|s| s.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    println!("Approval {id}  status:{status}");

    match resp.get("request") {
        Some(request) if !request.is_null() => {
            let tool = request
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            println!("Tool: {tool}");
            if let Some(input) = request.get("tool_input") {
                let pretty =
                    serde_json::to_string_pretty(input).unwrap_or_else(|_| input.to_string());
                println!("Input:\n{pretty}");
            }
        }
        _ => println!("(request detail no longer available; approval already resolved)"),
    }

    Ok(())
}

fn respond(
    client: &ServerClient,
    id: &str,
    approve: bool,
    deny: bool,
    reason: Option<&str>,
    answers: &[String],
) -> Result<(), client::ClientError> {
    let status = if deny {
        serde_json::json!({ "status": "denied", "reason": reason })
    } else if approve || !answers.is_empty() {
        serde_json::json!({ "status": "approved" })
    } else {
        return Err(client::ClientError::Usage(
            "Specify --approve, --deny, or at least one --answer.".to_string(),
        ));
    };

    let mut body = serde_json::json!({
        "status": status,
        "responded_by": responded_by(),
    });

    if !answers.is_empty() {
        let mut map = serde_json::Map::new();
        for pair in answers {
            let (question, option) = pair.split_once('=').ok_or_else(|| {
                client::ClientError::Usage(format!(
                    "Invalid --answer {pair:?}; expected \"question=option\"."
                ))
            })?;
            map.insert(
                question.to_string(),
                serde_json::Value::String(option.to_string()),
            );
        }
        body["answers"] = serde_json::Value::Object(map);
    }

    let resp = client.post(&format!("/rpc/approvals/{id}/respond"), &body)?;
    let status = resp
        .get("status")
        .and_then(|s| s.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    println!("Approval {id}: {status}");
    Ok(())
}

/// Stamp the responder from the session identity. Inside a chro session
/// `CHRO_TASK_ID` is set, so the response is attributed to that agent;
/// otherwise it is a human running the CLI directly.
fn responded_by() -> serde_json::Value {
    match std::env::var("CHRO_TASK_ID") {
        Ok(task) if !task.is_empty() => {
            serde_json::json!({ "kind": "agent", "task": task })
        }
        _ => serde_json::json!({ "kind": "user" }),
    }
}
