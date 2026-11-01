//! `chro project ...`

use std::{path::PathBuf, process::Command, process::ExitCode};

use clap::Subcommand;
use server_contract::{
    api::EnsureProject,
    routes::{self, NoBody},
    ErrorBody, ErrorCode,
};

use super::{
    client::Client,
    output::{fail, finish, Failure, Mode},
};

#[derive(Subcommand, Debug)]
pub enum ProjectCommand {
    /// List registered projects
    List,
    /// Show a project; defaults to the one containing the current directory
    Show {
        /// Slug, id, or path:<dir>
        project: Option<String>,
    },
    /// Register a repository or folder as a project
    Add {
        /// Defaults to the repository or folder of the current directory
        path: Option<PathBuf>,
    },
}

/// The repository root of the current directory, or the directory itself
/// when it is not in a repository (folders are projects too).
fn cwd_root() -> Result<PathBuf, ErrorBody> {
    let cwd = std::env::current_dir()
        .map_err(|err| ErrorBody::new(ErrorCode::Usage, format!("current directory: {err}")))?;
    let toplevel = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&cwd)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()));
    Ok(toplevel.unwrap_or(cwd))
}

pub(crate) fn cwd_project_selector() -> Result<String, ErrorBody> {
    Ok(format!("path:{}", cwd_root()?.display()))
}

fn absolute(path: PathBuf) -> Result<PathBuf, ErrorBody> {
    if path.is_absolute() {
        return Ok(path);
    }
    let cwd = std::env::current_dir()
        .map_err(|err| ErrorBody::new(ErrorCode::Usage, format!("current directory: {err}")))?;
    Ok(cwd.join(path))
}

pub(crate) fn run(command: ProjectCommand, client: Result<Client, ErrorBody>, mode: Mode) -> ExitCode {
    let client = match client {
        Ok(client) => client,
        Err(err) => return fail(mode, err),
    };
    match command {
        ProjectCommand::List => finish(mode, client.call(&routes::PROJECTS, &[], &[], None::<&NoBody>)),
        ProjectCommand::Show { project } => finish(
            mode,
            project
                .map(Ok)
                .unwrap_or_else(cwd_project_selector)
                .map_err(Failure::from)
                .and_then(|selector| client.call(&routes::PROJECT, &[&selector], &[], None)),
        ),
        ProjectCommand::Add { path } => finish(
            mode,
            path.map(absolute)
                .unwrap_or_else(cwd_root)
                .map_err(Failure::from)
                .and_then(|path| {
                    client.call(
                        &routes::PROJECT_ENSURE,
                        &[],
                        &[],
                        Some(&EnsureProject {
                            path: path.display().to_string(),
                        }),
                    )
                }),
        ),
    }
}
