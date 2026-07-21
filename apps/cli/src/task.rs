use std::path::Path;

use clap::Subcommand;

use crate::client::{self, ServerClient};

#[derive(Subcommand, Debug)]
pub enum TaskCommand {
    /// List tasks for the current project
    List,

    /// Create a new task
    Create {
        /// Task title
        title: String,
        /// Task description
        #[arg(short, long)]
        description: Option<String>,
        /// Prompt for the agent
        #[arg(long)]
        prompt: Option<String>,
        /// Attach a previous task/session as structured context
        #[arg(long = "ref-session", value_name = "TASK")]
        ref_sessions: Vec<String>,
        /// Skip agent execution (create task only)
        #[arg(long)]
        no_run: bool,
    },

    /// Show or update task status
    Status {
        /// Task ID or slug
        task: String,
        /// New status (pending, in_progress, completed, failed, cancelled)
        #[arg(value_name = "STATUS")]
        new_status: Option<String>,
    },

    /// Start an agent execution on a task
    Run {
        /// Task ID or slug
        task: String,
        /// Prompt for the agent
        #[arg(short, long)]
        prompt: Option<String>,
        /// Attach a previous task/session as structured context
        #[arg(long = "ref-session", value_name = "TASK")]
        ref_sessions: Vec<String>,
    },

    /// Print the markdown transcript for a task (all runs combined,
    /// chronological order). This is what other agents should fetch when a
    /// `<past_session>` tag references this task.
    Logs {
        /// Task ID or slug
        task: String,
    },

    /// List context references attached to a task
    Refs {
        /// Task ID or slug
        task: String,
    },

    /// List tasks/sessions that reference this task
    ReferencedBy {
        /// Task ID or slug
        task: String,
    },

    /// Cancel a running execution
    Cancel {
        /// Task ID or slug
        task: String,
        /// Run sequence to cancel (1-indexed). Defaults to the latest run.
        #[arg(short, long)]
        run: Option<u32>,
    },

    /// Show diff for a task
    Diff {
        /// Task ID or slug
        task: String,
        /// Run sequence to inspect (1-indexed). Defaults to the latest run.
        #[arg(short, long)]
        run: Option<u32>,
    },

    /// Merge task changes into target branch
    Merge {
        /// Task ID or slug
        task: String,
        /// Commit message
        #[arg(short, long)]
        message: Option<String>,
        /// Run sequence to merge (1-indexed). Defaults to the latest run.
        #[arg(short, long)]
        run: Option<u32>,
    },


    /// Delegate part of a session's work to a new session. The child starts
    /// immediately with a digest of the delegating session in its boot
    /// prompt; when every task delegated by that session has finished, the
    /// results are handed back in one packet and the delegating session
    /// wakes.
    Delegate {
        /// The brief for the delegated work
        prompt: String,
        /// Delegating task ID or slug. Defaults to $CHRO_TASK_ID, which chro
        /// sets inside every session it runs.
        #[arg(long, value_name = "TASK")]
        from: Option<String>,
    },

    /// Rebase task branch onto a new base
    Rebase {
        /// Task ID or slug
        task: String,
        /// Branch to rebase onto (default: target branch of the run)
        #[arg(short, long)]
        onto: Option<String>,
        /// Run sequence to rebase (1-indexed). Defaults to the latest run.
        #[arg(short, long)]
        run: Option<u32>,
    },
}

pub fn run(
    cmd: &TaskCommand,
    client: &ServerClient,
    project_override: Option<&Path>,
) -> Result<(), client::ClientError> {
    match cmd {
        TaskCommand::List => list(client, project_override),
        TaskCommand::Create {
            title,
            description,
            prompt,
            ref_sessions,
            no_run,
        } => create(
            client,
            project_override,
            title,
            description.as_deref(),
            prompt.as_deref(),
            ref_sessions,
            !*no_run,
        ),
        TaskCommand::Status { task, new_status } => status(client, task, new_status.as_deref()),
        TaskCommand::Run {
            task,
            prompt,
            ref_sessions,
        } => run_task(
            client,
            project_override,
            task,
            prompt.as_deref(),
            ref_sessions,
        ),
        TaskCommand::Logs { task } => logs(client, task),
        TaskCommand::Refs { task } => refs(client, task),
        TaskCommand::ReferencedBy { task } => referenced_by(client, task),
        TaskCommand::Cancel { task, run } => cancel(client, task, *run),
        TaskCommand::Diff { task, run } => diff(client, task, *run),
        TaskCommand::Merge { task, message, run } => merge(client, task, message.as_deref(), *run),
        TaskCommand::Rebase { task, onto, run } => rebase(client, task, onto.as_deref(), *run),
        TaskCommand::Delegate { prompt, from } => delegate(client, prompt, from.as_deref()),
    }
}

fn list(client: &ServerClient, project_override: Option<&Path>) -> Result<(), client::ClientError> {
    let project = client::resolve_project(client, project_override)?;
    let git_path = project.git_repo_path.as_deref().unwrap_or("unknown");

    let resp = client.get(&format!("/tasks?workspace_path={}", urlencoded(git_path)))?;

    let tasks = resp
        .get("tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if tasks.is_empty() {
        println!("No tasks found.");
        return Ok(());
    }

    for task in &tasks {
        let id = task
            .get("slug")
            .and_then(|v| v.as_str())
            .or_else(|| task.get("id").and_then(|v| v.as_str()))
            .unwrap_or("-");
        let title = task.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let status = task.get("status").and_then(|v| v.as_str()).unwrap_or("?");
        println!("{status:<12} {id:<20} {title}");
    }

    Ok(())
}

fn create(
    client: &ServerClient,
    project_override: Option<&Path>,
    title: &str,
    description: Option<&str>,
    prompt: Option<&str>,
    ref_sessions: &[String],
    should_run: bool,
) -> Result<(), client::ClientError> {
    let project = client::resolve_project(client, project_override)?;
    let prompt_for_task = prompt.map(|value| with_session_context(value, ref_sessions));

    let body = serde_json::json!({
        "project_id": project.id,
        "title": title,
        "description": description,
        "prompt": prompt_for_task.as_deref(),
        "context_refs": context_refs_json(ref_sessions),
    });

    let resp = client.post("/rpc/tasks", &body)?;
    let task = &resp["task"];

    let id = task
        .get("slug")
        .and_then(|v| v.as_str())
        .or_else(|| task.get("id").and_then(|v| v.as_str()))
        .unwrap_or("-");

    println!("Created task: {id}  {title}");

    if should_run {
        let task_id = task.get("id").and_then(|v| v.as_str()).unwrap_or(id);
        let workspace_path = project.git_repo_path.as_deref().unwrap_or("");
        let prompt_text = prompt_for_task
            .clone()
            .unwrap_or_else(|| with_session_context(title, ref_sessions));

        let run_body = serde_json::json!({
            "prompt": prompt_text,
            "workspace_path": workspace_path,
            "task_id": task_id,
            "mode": "auto",
            "context_refs": context_refs_json(ref_sessions),
        });

        client.post(&format!("/rpc/tasks/{task_id}/messages"), &run_body)?;

        println!("Execution started.");
        println!("View logs: chro task logs {id}");
    }

    Ok(())
}

fn status(
    client: &ServerClient,
    task: &str,
    new_status: Option<&str>,
) -> Result<(), client::ClientError> {
    match new_status {
        Some(status_str) => {
            let body = serde_json::json!({ "status": status_str });
            let resp = client.patch(&format!("/rpc/tasks/{task}/status"), &body)?;
            let returned = &resp["task"];
            let current = returned
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            println!("Task {task} status: {current}");
        }
        None => {
            let resp = client.get(&format!("/rpc/tasks/{task}/runs"))?;
            let runs = resp
                .get("runs")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            if runs.is_empty() {
                println!("Task {task}: no runs yet.");
                return Ok(());
            }

            println!("Task {task} runs (latest first):");
            // Server returns DESC; print sequence numbers as 1=earliest.
            let total = runs.len();
            for (offset, run) in runs.iter().enumerate() {
                let sequence = total - offset;
                let status = run.get("status").and_then(|v| v.as_str()).unwrap_or("?");
                let branch = run
                    .get("branch_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let target = run
                    .get("target_branch")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                println!("  #{sequence:<3} {status:<12} branch:{branch}  target:{target}");
            }
        }
    }

    Ok(())
}

fn run_task(
    client: &ServerClient,
    project_override: Option<&Path>,
    task: &str,
    prompt: Option<&str>,
    ref_sessions: &[String],
) -> Result<(), client::ClientError> {
    let project = client::resolve_project(client, project_override)?;
    let workspace_path = project.git_repo_path.as_deref().unwrap_or("");
    let prompt_text = with_session_context(prompt.unwrap_or("Execute this task"), ref_sessions);

    let body = serde_json::json!({
        "prompt": prompt_text,
        "workspace_path": workspace_path,
        "task_id": task,
        "mode": "auto",
        "context_refs": context_refs_json(ref_sessions),
    });

    client.post(&format!("/rpc/tasks/{task}/messages"), &body)?;

    println!("Execution started for {task}.");
    println!("View logs: chro task logs {task}");
    Ok(())
}

fn logs(client: &ServerClient, task: &str) -> Result<(), client::ClientError> {
    let resp = client.get(&format!("/rpc/tasks/{task}/transcript"))?;
    let markdown = resp.get("markdown").and_then(|v| v.as_str()).unwrap_or("");
    print!("{markdown}");
    Ok(())
}

fn refs(client: &ServerClient, task: &str) -> Result<(), client::ClientError> {
    print_refs_response(client.get(&format!("/rpc/tasks/{task}/context-refs"))?)
}

fn referenced_by(client: &ServerClient, task: &str) -> Result<(), client::ClientError> {
    print_refs_response(client.get(&format!("/rpc/tasks/{task}/referenced-by"))?)
}

fn print_refs_response(resp: serde_json::Value) -> Result<(), client::ClientError> {
    let refs = resp
        .get("refs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if refs.is_empty() {
        println!("No context refs found.");
        return Ok(());
    }

    for context_ref in refs {
        let kind = context_ref
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        let mode = context_ref
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("link");
        let target = context_ref
            .get("target_task_id")
            .and_then(|v| v.as_str())
            .or_else(|| context_ref.get("path").and_then(|v| v.as_str()))
            .unwrap_or("-");
        println!("{kind:<10} {mode:<10} {target}");
    }

    Ok(())
}

fn context_refs_json(ref_sessions: &[String]) -> Vec<serde_json::Value> {
    ref_sessions
        .iter()
        .map(|task| {
            serde_json::json!({
                "kind": "session",
                "task_id": task,
                "mode": "transcript",
            })
        })
        .collect()
}

fn with_session_context(prompt: &str, ref_sessions: &[String]) -> String {
    if ref_sessions.is_empty() {
        return prompt.to_string();
    }

    let tags = ref_sessions
        .iter()
        .map(|task| {
            format!(
                "<past_session task_id=\"{}\">\nReferenced session. A summary is injected at execution time; run `chro task logs {}` for the full transcript.\n</past_session>",
                escape_xml_attr(task),
                task
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!("<context>\n{tags}\n</context>\n{prompt}")
}

fn escape_xml_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn cancel(client: &ServerClient, task: &str, run: Option<u32>) -> Result<(), client::ClientError> {
    let path = match run {
        Some(n) => format!("/rpc/tasks/{task}/cancel?run={n}"),
        None => format!("/rpc/tasks/{task}/cancel"),
    };
    client.post_no_content(&path, &serde_json::json!({}))?;
    println!("Cancelled: {task}");
    Ok(())
}

fn diff(client: &ServerClient, task: &str, run: Option<u32>) -> Result<(), client::ClientError> {
    let path = match run {
        Some(n) => format!("/rpc/tasks/{task}/diff?run={n}"),
        None => format!("/rpc/tasks/{task}/diff"),
    };
    let resp = client.get(&path)?;

    let branch = resp
        .get("branch_name")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let target = resp
        .get("target_branch")
        .and_then(|v| v.as_str())
        .unwrap_or("main");
    let status = resp.get("status").and_then(|v| v.as_str()).unwrap_or("?");

    println!("Task {task}  status:{status}  branch:{branch}  target:{target}");

    let before = resp.get("before_head_commit").and_then(|v| v.as_str());
    let after = resp.get("after_head_commit").and_then(|v| v.as_str());

    match (before, after) {
        (Some(b), Some(a)) => println!("Commits: {b:.8}..{a:.8}"),
        _ => println!("No commit range available yet."),
    }

    Ok(())
}

fn merge(
    client: &ServerClient,
    task: &str,
    message: Option<&str>,
    run: Option<u32>,
) -> Result<(), client::ClientError> {
    let body = serde_json::json!({ "commit_message": message });
    let path = match run {
        Some(n) => format!("/rpc/tasks/{task}/merge?run={n}"),
        None => format!("/rpc/tasks/{task}/merge"),
    };
    let resp = client.post(&path, &body)?;

    let commit = resp
        .get("merge_commit")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let target = resp
        .get("target_branch")
        .and_then(|v| v.as_str())
        .unwrap_or("?");

    println!("Merged into {target}  commit:{commit:.8}");
    Ok(())
}

fn rebase(
    client: &ServerClient,
    task: &str,
    onto: Option<&str>,
    run: Option<u32>,
) -> Result<(), client::ClientError> {
    let new_base = match onto {
        Some(branch) => branch.to_string(),
        None => {
            // Look up the run's target branch.
            let path = match run {
                Some(n) => format!("/rpc/tasks/{task}/diff?run={n}"),
                None => format!("/rpc/tasks/{task}/diff"),
            };
            let resp = client.get(&path)?;
            resp.get("target_branch")
                .and_then(|v| v.as_str())
                .unwrap_or("main")
                .to_string()
        }
    };

    let body = serde_json::json!({ "new_base_branch": new_base });
    let path = match run {
        Some(n) => format!("/rpc/tasks/{task}/rebase?run={n}"),
        None => format!("/rpc/tasks/{task}/rebase"),
    };
    let resp = client.post(&path, &body)?;

    let success = resp
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if success {
        println!("Rebased {task} onto {new_base}");
    } else {
        eprintln!("Rebase failed for {task}");
        std::process::exit(1);
    }

    Ok(())
}


fn delegate(
    client: &ServerClient,
    prompt: &str,
    from: Option<&str>,
) -> Result<(), client::ClientError> {
    let from = match from {
        Some(value) => value.to_string(),
        None => std::env::var("CHRO_TASK_ID").map_err(|_| {
            client::ClientError::Usage(
                "No delegating session: pass --from <task>, or run inside a chro session (which sets CHRO_TASK_ID).".to_string(),
            )
        })?,
    };
    let body = serde_json::json!({ "prompt": prompt });
    let resp = client.post(&format!("/rpc/tasks/{}/delegate", urlencoded(&from)), &body)?;
    let task = &resp["task"];
    let id = task
        .get("slug")
        .and_then(|v| v.as_str())
        .or_else(|| task.get("id").and_then(|v| v.as_str()))
        .unwrap_or("-");
    let title = task.get("title").and_then(|v| v.as_str()).unwrap_or("-");
    println!("Delegated to new session: {id}  {title}");
    println!("It is running now. When every task delegated by this session has finished, the results are handed back here in one packet.");
    Ok(())
}

fn urlencoded(s: &str) -> String {
    s.replace('%', "%25")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('&', "%26")
        .replace('?', "%3F")
}
