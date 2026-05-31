use std::path::Path;

use clap::Subcommand;

use super::client::{self, ServerClient};

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
        /// Skip agent execution (create task only)
        #[arg(long)]
        no_run: bool,
    },

    /// Show or update task status
    Status {
        /// Task ID or slug
        id: String,
        /// New status (pending, in_progress, completed, failed, cancelled)
        #[arg(value_name = "STATUS")]
        new_status: Option<String>,
    },

    /// Start an agent execution on a task
    Run {
        /// Task ID or slug
        id: String,
        /// Prompt for the agent
        #[arg(short, long)]
        prompt: Option<String>,
    },

    /// Show execution logs for a task run
    Logs {
        /// Task run ID or slug
        id: String,
    },

    /// Cancel a running execution
    Cancel {
        /// Task run ID or slug
        id: String,
    },

    /// Show diff for a task run
    Diff {
        /// Task run ID or slug
        id: String,
    },

    /// Merge task run changes into target branch
    Merge {
        /// Task run ID or slug
        id: String,
        /// Commit message
        #[arg(short, long)]
        message: Option<String>,
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
            no_run,
        } => create(
            client,
            project_override,
            title,
            description.as_deref(),
            prompt.as_deref(),
            !*no_run,
        ),
        TaskCommand::Status { id, new_status } => status(client, id, new_status.as_deref()),
        TaskCommand::Run { id, prompt } => {
            run_task(client, project_override, id, prompt.as_deref())
        }
        TaskCommand::Logs { id } => logs(client, id),
        TaskCommand::Cancel { id } => cancel(client, id),
        TaskCommand::Diff { id } => diff(client, id),
        TaskCommand::Merge { id, message } => merge(client, id, message.as_deref()),
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
    should_run: bool,
) -> Result<(), client::ClientError> {
    let project = client::resolve_project(client, project_override)?;

    let body = serde_json::json!({
        "project_id": project.id,
        "title": title,
        "description": description,
        "prompt": prompt,
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
        let prompt_text = prompt.unwrap_or(title);

        let run_body = serde_json::json!({
            "prompt": prompt_text,
            "workspace_path": workspace_path,
            "task_id": task_id,
            "mode": "auto",
        });

        let run_resp = client.post(&format!("/rpc/tasks/{task_id}/messages"), &run_body)?;
        let run_id = run_resp
            .get("task_run_slug")
            .and_then(|v| v.as_str())
            .or_else(|| run_resp.get("task_run_id").and_then(|v| v.as_str()))
            .unwrap_or("-");

        println!("Execution started: {run_id}");
        println!("View logs: chro task logs {run_id}");
    }

    Ok(())
}

fn status(
    client: &ServerClient,
    id: &str,
    new_status: Option<&str>,
) -> Result<(), client::ClientError> {
    match new_status {
        Some(status_str) => {
            let body = serde_json::json!({ "status": status_str });
            let resp = client.patch(&format!("/rpc/tasks/{id}/status"), &body)?;
            let task = &resp["task"];
            let current = task.get("status").and_then(|v| v.as_str()).unwrap_or("?");
            println!("Task {id} status: {current}");
        }
        None => {
            let resp = client.get(&format!("/rpc/tasks/{id}/runs"))?;
            let runs = resp
                .get("runs")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            if runs.is_empty() {
                println!("Task {id}: no runs yet.");
                return Ok(());
            }

            println!("Task {id} runs:");
            for run in &runs {
                let run_id = run
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .or_else(|| run.get("id").and_then(|v| v.as_str()))
                    .unwrap_or("-");
                let status = run.get("status").and_then(|v| v.as_str()).unwrap_or("?");
                let branch = run
                    .get("branch_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                println!("  {status:<12} {run_id:<20} branch:{branch}");
            }
        }
    }

    Ok(())
}

fn run_task(
    client: &ServerClient,
    project_override: Option<&Path>,
    id: &str,
    prompt: Option<&str>,
) -> Result<(), client::ClientError> {
    let project = client::resolve_project(client, project_override)?;
    let workspace_path = project.git_repo_path.as_deref().unwrap_or("");

    let prompt_text = prompt.unwrap_or("Execute this task");

    let body = serde_json::json!({
        "prompt": prompt_text,
        "workspace_path": workspace_path,
        "task_id": id,
        "mode": "auto",
    });

    let resp = client.post(&format!("/rpc/tasks/{id}/messages"), &body)?;
    let task_run_id = resp
        .get("task_run_slug")
        .and_then(|v| v.as_str())
        .or_else(|| resp.get("task_run_id").and_then(|v| v.as_str()))
        .unwrap_or("-");

    println!("Execution started: {task_run_id}");
    println!("View logs: chro task logs {task_run_id}");
    Ok(())
}

fn logs(client: &ServerClient, id: &str) -> Result<(), client::ClientError> {
    let resp = client.get(&format!("/rpc/task-runs/{id}/logs"))?;
    let entries = resp
        .get("entries")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if entries.is_empty() {
        println!("No logs yet.");
        return Ok(());
    }

    for entry in &entries {
        match entry.get("type").and_then(|v| v.as_str()) {
            Some("stdout") => {
                if let Some(text) = entry.get("payload").and_then(|v| v.as_str()) {
                    print!("{text}");
                }
            }
            Some("stderr") => {
                if let Some(text) = entry.get("payload").and_then(|v| v.as_str()) {
                    eprint!("{text}");
                }
            }
            Some("user_prompt") => {
                if let Some(text) = entry.get("payload").and_then(|v| v.as_str()) {
                    println!(">>> {text}");
                }
            }
            Some("finished") => {
                println!("--- Execution finished ---");
            }
            _ => {}
        }
    }

    Ok(())
}

fn cancel(client: &ServerClient, id: &str) -> Result<(), client::ClientError> {
    client.post_no_content(
        &format!("/rpc/task-runs/{id}/cancel"),
        &serde_json::json!({}),
    )?;
    println!("Cancelled: {id}");
    Ok(())
}

fn diff(client: &ServerClient, id: &str) -> Result<(), client::ClientError> {
    let resp = client.get(&format!("/rpc/task-runs/{id}/with-task"))?;

    let branch = resp
        .get("task_run")
        .and_then(|r| r.get("branch_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let target = resp
        .get("task_run")
        .and_then(|r| r.get("target_branch"))
        .and_then(|v| v.as_str())
        .unwrap_or("main");
    let status = resp
        .get("task_run")
        .and_then(|r| r.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("?");

    println!("Run {id}  status:{status}  branch:{branch}  target:{target}");

    let before = resp
        .get("task_run")
        .and_then(|r| r.get("before_head_commit"))
        .and_then(|v| v.as_str());
    let after = resp
        .get("task_run")
        .and_then(|r| r.get("after_head_commit"))
        .and_then(|v| v.as_str());

    match (before, after) {
        (Some(b), Some(a)) => println!("Commits: {b:.8}..{a:.8}"),
        _ => println!("No commit range available yet."),
    }

    Ok(())
}

fn merge(
    client: &ServerClient,
    id: &str,
    message: Option<&str>,
) -> Result<(), client::ClientError> {
    let body = serde_json::json!({ "commit_message": message });
    let resp = client.post(&format!("/rpc/task-runs/{id}/merge"), &body)?;

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

fn urlencoded(s: &str) -> String {
    s.replace('%', "%25")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('&', "%26")
        .replace('?', "%3F")
}
