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
pub use process::{ExecutionProcess, ProcessExit, PtyProcess};
pub use executors::claude::ClaudeCode;
pub use executors::claude::ClaudeLogProcessor;
pub use executors::claude::{ApprovalStatus, ClaudeContentItem, ClaudeJson};
pub use executors::codex::{
    AskForApproval, Codex, ReasoningEffort, ReasoningSummary, ReasoningSummaryFormat, SandboxMode,
};
pub use mcp_config::{
    LoadedMcpConfig, McpConfig, McpConfigError, McpConfigPayload, SavedMcpConfig, load_mcp_config,
    save_mcp_config,
};
pub use profile::{
    AuthLoginResult, AuthStatusResult, ClaudeVersionResult, ExecutorConfig, ExecutorConfigs,
    ExecutorInstallInfo, ExecutorInstallStatusResult, ExecutorProfileId, InstallableTool,
    McpServerStatus, McpStatusResult, ModelPreset, PermissionMode,
    ProfileError, ToolInstallResult, anthropic_model_presets, canonical_variant_key,
    check_mcp_status, detect_claude_version, get_auth_status_all, get_install_status_all,
    install_tool, to_default_variant, trigger_auth_login,
};

pub use approvals::{
    ExecutorApprovalError, ExecutorApprovalService, NoopExecutorApprovalService, QuestionStatus,
};
