pub mod approvals;
pub mod cli_manifest;
pub mod cli_resolver;
pub mod command;
pub mod env;
pub mod executors;
pub mod logs;
pub mod mcp_config;
pub mod process;
pub mod profile;
pub mod shell;
pub mod stdout_dup;

pub use executors::{
    AppendPrompt, AvailabilityInfo, BaseAgentCapability, BaseCodingAgent, CodingAgent,
    CodingAgentKind, ExecutorError, ExecutorExitResult, ExecutorExitSignal, SpawnedChild,
    StandardCodingAgentExecutor,
};

pub use command::{CmdOverrides, CommandBuildError, CommandBuilder, CommandParts, apply_overrides};
pub use env::{ExecutionEnv, RepoContext};
pub use executors::claude::ClaudeCode;
pub use executors::claude::ClaudeExecutionMode;
pub use executors::claude::ClaudeLogProcessor;
pub use executors::claude::{ApprovalStatus, ClaudeContentItem, ClaudeJson};
pub use executors::codex::{
    AskForApproval, Codex, ReasoningEffort, ReasoningSummary, ReasoningSummaryFormat, SandboxMode,
};
pub use executors::pi::auth::{
    PiCredentialInfo, delete_credential as delete_pi_credential,
    list_credentials as list_pi_credentials, set_api_key as set_pi_api_key,
};
pub use executors::pi::models::{PiModelOption, list_available_models as list_pi_models};
pub use executors::pi::{Pi, ThinkingLevel};
pub use mcp_config::{
    LoadedMcpConfig, McpConfig, McpConfigError, McpConfigPayload, SavedMcpConfig, load_mcp_config,
    save_mcp_config,
};
pub use process::{ExecutionProcess, ProcessExit, PtyProcess};
pub use profile::{
    AuthLoginCommand, AuthStatusResult, ClaudeVersionResult, ExecutorConfig, ExecutorConfigs,
    ExecutorInstallInfo, ExecutorInstallStatusResult, ExecutorProfileId, InstallableTool,
    McpServerStatus, McpStatusResult, PermissionMode, ProfileError, ToolInstallResult,
    canonical_variant_key, check_mcp_status, detect_claude_version,
    get_auth_status_all, get_install_status_all, install_tool, resolve_auth_login_command,
    to_default_variant,
};

pub use approvals::{
    ExecutorApprovalError, ExecutorApprovalService, NoopExecutorApprovalService, QuestionStatus,
};
