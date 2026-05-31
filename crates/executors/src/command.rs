use std::{collections::HashMap, path::PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

use crate::cli_manifest::CliManifest;
use crate::cli_resolver::resolve_cli;
use crate::executors::ExecutorError;
use crate::shell::resolve_executable_path;

#[derive(Debug, Error)]
pub enum CommandBuildError {
    #[error("base command cannot be parsed: {0}")]
    InvalidBase(String),
    #[error("base command is empty after parsing")]
    EmptyCommand,
    #[error("failed to quote command: {0}")]
    QuoteError(#[from] shlex::QuoteError),
    #[error("invalid shell parameters: {0}")]
    InvalidShellParams(String),
}

#[derive(Debug, Clone)]
pub struct CommandParts {
    program: String,
    args: Vec<String>,
    /// Manifest used to drive layered resolution. `None` when the caller
    /// overrode the base command (`CmdOverrides::base_command_override`) — in
    /// that case we trust the user's literal command and fall back to the
    /// generic [`resolve_executable_path`] discovery sequence.
    manifest: Option<&'static CliManifest>,
}

impl CommandParts {
    pub fn new(program: String, args: Vec<String>) -> Self {
        Self {
            program,
            args,
            manifest: None,
        }
    }

    pub fn with_manifest(mut self, manifest: &'static CliManifest) -> Self {
        self.manifest = Some(manifest);
        self
    }

    pub async fn into_resolved(self) -> Result<(PathBuf, Vec<String>), ExecutorError> {
        let CommandParts {
            program,
            args,
            manifest,
        } = self;
        let executable = match manifest {
            Some(m) => match resolve_cli(m).await {
                Some(resolved) => resolved.path,
                None => {
                    return Err(ExecutorError::ExecutableNotFound {
                        program: m.command.to_string(),
                        install_hint: Some(m.install_hint.to_string()),
                    });
                }
            },
            None => match resolve_executable_path(&program).await {
                Some(found) => found,
                None => {
                    return Err(ExecutorError::ExecutableNotFound {
                        program,
                        install_hint: None,
                    });
                }
            },
        };
        Ok((executable, args))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, Default)]
pub struct CmdOverrides {
    #[schemars(
        title = "Base Command Override",
        description = "Override the base command with a custom command"
    )]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_command_override: Option<String>,
    #[schemars(
        title = "Additional Parameters",
        description = "Additional parameters to append to the base command"
    )]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_params: Option<Vec<String>>,
    #[schemars(
        title = "Environment Variables",
        description = "Environment variables to set when running the executor"
    )]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
}

impl CmdOverrides {
    pub fn is_empty(&self) -> bool {
        self.base_command_override.is_none()
            && self
                .additional_params
                .as_ref()
                .map_or(true, |v| v.is_empty())
            && self.env.as_ref().map_or(true, |v| v.is_empty())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema)]
pub struct CommandBuilder {
    /// Base executable command. When constructed via [`Self::for_manifest`],
    /// this is the manifest's primary `command`. When constructed via
    /// [`Self::new`] or after [`Self::override_base`], it can be an arbitrary
    /// shell-splittable command string.
    pub base: String,
    /// Optional parameters to append to the base command
    pub params: Option<Vec<String>>,
    /// Manifest reference, set when [`Self::for_manifest`] was used and not
    /// yet overridden. Skipped in serialization since `&'static` references
    /// can't round-trip through JSON / schema generation, and the manifest
    /// is recovered from the executor type on the receiving side.
    #[serde(skip)]
    #[ts(skip)]
    #[schemars(skip)]
    pub manifest: Option<&'static CliManifest>,
}

impl CommandBuilder {
    pub fn new<S: Into<String>>(base: S) -> Self {
        Self {
            base: base.into(),
            params: None,
            manifest: None,
        }
    }

    /// Construct a builder bound to a CLI manifest. The manifest drives the
    /// layered resolution in [`CommandParts::into_resolved`]; if the caller
    /// later overrides the base command, the manifest is cleared so the
    /// user's literal command wins.
    pub fn for_manifest(manifest: &'static CliManifest) -> Self {
        Self {
            base: manifest.command.to_string(),
            params: None,
            manifest: Some(manifest),
        }
    }

    pub fn params<I>(mut self, params: I) -> Self
    where
        I: IntoIterator,
        I::Item: Into<String>,
    {
        self.params = Some(params.into_iter().map(|p| p.into()).collect());
        self
    }

    pub fn override_base<S: Into<String>>(mut self, base: S) -> Self {
        self.base = base.into();
        // Clear the manifest binding: once the user supplies a literal
        // command, we cannot assume the binary lives at any candidate path
        // the manifest declares.
        self.manifest = None;
        self
    }

    fn extend_shell_params<I>(mut self, more: I) -> Result<Self, CommandBuildError>
    where
        I: IntoIterator,
        I::Item: Into<String>,
    {
        let joined = more
            .into_iter()
            .map(|p| p.into())
            .collect::<Vec<String>>()
            .join(" ");

        if joined.trim().is_empty() {
            return Ok(self);
        }

        let extra: Vec<String> = split_command_line(&joined)
            .map_err(|err| CommandBuildError::InvalidShellParams(format!("{joined}: {err}")))?;

        match &mut self.params {
            Some(p) => p.extend(extra),
            None => self.params = Some(extra),
        }
        Ok(self)
    }

    pub fn extend_params<I>(mut self, more: I) -> Self
    where
        I: IntoIterator,
        I::Item: Into<String>,
    {
        let extra: Vec<String> = more.into_iter().map(|p| p.into()).collect();
        match &mut self.params {
            Some(p) => p.extend(extra),
            None => self.params = Some(extra),
        }
        self
    }

    pub fn build_initial(&self) -> Result<CommandParts, CommandBuildError> {
        self.build(&[])
    }

    pub fn build_follow_up(
        &self,
        additional_args: &[String],
    ) -> Result<CommandParts, CommandBuildError> {
        self.build(additional_args)
    }

    fn build(&self, additional_args: &[String]) -> Result<CommandParts, CommandBuildError> {
        let mut parts = vec![];
        let base_parts = split_command_line(&self.base)?;
        parts.extend(base_parts);
        if let Some(ref params) = self.params {
            parts.extend(params.clone());
        }
        parts.extend(additional_args.iter().cloned());

        if parts.is_empty() {
            return Err(CommandBuildError::EmptyCommand);
        }

        let program = parts.remove(0);
        let mut cp = CommandParts::new(program, parts);
        if let Some(manifest) = self.manifest {
            cp = cp.with_manifest(manifest);
        }
        Ok(cp)
    }
}

fn split_command_line(input: &str) -> Result<Vec<String>, CommandBuildError> {
    #[cfg(windows)]
    {
        let parts = winsplit::split(input);
        if parts.is_empty() {
            Err(CommandBuildError::EmptyCommand)
        } else {
            Ok(parts)
        }
    }

    #[cfg(not(windows))]
    {
        shlex::split(input).ok_or_else(|| CommandBuildError::InvalidBase(input.to_string()))
    }
}

pub fn apply_overrides(
    builder: CommandBuilder,
    overrides: &CmdOverrides,
) -> Result<CommandBuilder, CommandBuildError> {
    let builder = if let Some(ref base) = overrides.base_command_override {
        builder.override_base(base.clone())
    } else {
        builder
    };
    if let Some(ref extra) = overrides.additional_params {
        builder.extend_shell_params(extra.clone())
    } else {
        Ok(builder)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_base_command_with_args() {
        let builder = CommandBuilder::new("npx -y my-cli@latest")
            .params(["--foo", "bar"])
            .extend_params(["--flag"]);
        let parts = builder.build_initial().expect("should parse");
        assert_eq!(parts.program, "npx");
        assert_eq!(
            parts.args,
            vec!["-y", "my-cli@latest", "--foo", "bar", "--flag"]
        );
    }

    #[test]
    fn apply_override_changes_base_and_params() {
        let builder = CommandBuilder::new("claude").params(["--print"]);
        let overrides = CmdOverrides {
            base_command_override: Some("custom".into()),
            additional_params: Some(vec!["--extra".into()]),
            env: None,
        };
        let parts = apply_overrides(builder, &overrides)
            .expect("should apply overrides")
            .build_initial()
            .expect("should build");
        assert_eq!(parts.program, "custom");
        assert_eq!(parts.args, vec!["--print", "--extra"]);
    }

    #[test]
    fn for_manifest_carries_manifest_into_parts() {
        let builder = CommandBuilder::for_manifest(&crate::cli_manifest::CODEX);
        assert_eq!(builder.base, "codex");
        let parts = builder.build_initial().expect("should build");
        assert_eq!(parts.program, "codex");
        assert!(parts.manifest.is_some());
        assert_eq!(parts.manifest.unwrap().name, "codex");
    }

    #[test]
    fn override_base_clears_manifest_binding() {
        let builder = CommandBuilder::for_manifest(&crate::cli_manifest::CODEX);
        let overrides = CmdOverrides {
            base_command_override: Some("/opt/custom/codex".into()),
            additional_params: None,
            env: None,
        };
        let built = apply_overrides(builder, &overrides)
            .expect("override applies")
            .build_initial()
            .expect("should build");
        assert_eq!(built.program, "/opt/custom/codex");
        // When the user overrides the base command, manifest-driven
        // resolution is bypassed — falling back to the generic
        // resolve_executable_path path that trusts the literal command.
        assert!(
            built.manifest.is_none(),
            "manifest must be cleared after base override"
        );
    }

    #[tokio::test]
    async fn not_found_with_manifest_includes_install_hint() {
        // Build a manifest that points exclusively at a path that cannot exist
        // and a non-existent env override; resolution must yield the install
        // hint in the error payload.
        let manifest = Box::leak(Box::new(crate::cli_manifest::CliManifest {
            name: "ghost",
            command: "ghost-cli",
            env_override: Some("CHRO_TEST_GHOST_BIN_NEVER_SET"),
            home_env: None,
            default_home: None,
            candidates: &[crate::cli_manifest::Candidate::Absolute(
                "/definitely/does/not/exist/ghost-cli",
            )],
            install_hint: "ghost CLI is not real — this is a unit test.",
        }));
        let parts = CommandParts::new("ghost-cli".to_string(), Vec::new()).with_manifest(manifest);
        let err = parts.into_resolved().await.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("ghost-cli"),
            "error must name the program: {msg}"
        );
        assert!(msg.contains("ghost CLI"), "error must carry hint: {msg}");
    }

    #[test]
    fn empty_base_errors() {
        let builder = CommandBuilder::new("");
        let err = builder.build_initial().unwrap_err();
        assert!(matches!(err, CommandBuildError::EmptyCommand));
    }
}
