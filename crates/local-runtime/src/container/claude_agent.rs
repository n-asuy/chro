use std::sync::Arc;

use anyhow::anyhow;
use approvals::ApprovalStatus;
use executors::{
    profile::{PermissionMode, PermissionRuntimeConfig},
    ExecutorApprovalError, ExecutorApprovalService, QuestionStatus,
};
use log_types::LogEntry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{io::AsyncWriteExt, process::ChildStdin, sync::Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{ContainerError, LocalContainerService};

const EXIT_PLAN_MODE: &str = "ExitPlanMode";

#[derive(Clone)]
pub struct ClaudeLogEmitter {
    service: LocalContainerService,
    task_run_id: Uuid,
}

impl ClaudeLogEmitter {
    pub fn new(service: LocalContainerService, task_run_id: Uuid) -> Self {
        Self {
            service,
            task_run_id,
        }
    }

    pub async fn log_json(&self, value: &Value) {
        if let Ok(serialized) = serde_json::to_string(value) {
            let _ = self
                .service
                .append_logs(self.task_run_id, &[LogEntry::Stdout(serialized)])
                .await;
        }
    }
}

#[derive(Clone)]
pub struct ClaudeAgentClient {
    approvals: Arc<dyn ExecutorApprovalService>,
    manual: bool,
    cancel: CancellationToken,
}

impl ClaudeAgentClient {
    pub fn new(
        approvals: Arc<dyn ExecutorApprovalService>,
        manual: bool,
        cancel: CancellationToken,
    ) -> Arc<Self> {
        Arc::new(Self {
            approvals,
            manual,
            cancel,
        })
    }

    pub async fn on_can_use_tool(
        &self,
        tool_name: String,
        input: Value,
        tool_use_id: Option<String>,
    ) -> Result<PermissionDecision, ExecutorApprovalError> {
        let requires_approval = self.manual || tool_name == "AskUserQuestion";

        if !requires_approval {
            return Ok(PermissionDecision::allow(input));
        }

        let Some(_call_id) = tool_use_id else {
            return Ok(PermissionDecision::allow(input));
        };

        let (decision, log_payload) = if tool_name == "AskUserQuestion" {
            let question_count = input
                .get("questions")
                .and_then(|v| v.as_array())
                .map(|arr| arr.len())
                .unwrap_or(1);
            let approval_id = self
                .approvals
                .create_question_approval(&tool_name, question_count)
                .await?;
            let status = self
                .approvals
                .wait_question_answer(&approval_id, self.cancel.clone())
                .await?;
            let decision = match status.clone() {
                QuestionStatus::Answered { answers } => {
                    let mut input_obj = input.as_object().cloned().unwrap_or_default();
                    input_obj.insert(
                        "answers".to_string(),
                        serde_json::to_value(answers).unwrap_or(Value::Null),
                    );
                    PermissionDecision::allow(Value::Object(input_obj))
                }
                QuestionStatus::TimedOut => {
                    PermissionDecision::deny("Question request timed out".into())
                }
            };
            let payload = serde_json::json!({
                "type": "question_response",
                "tool_name": tool_name,
                "approval_id": approval_id,
                "status": match status {
                    QuestionStatus::Answered { .. } => "answered",
                    QuestionStatus::TimedOut => "timed_out",
                },
            });
            (decision, payload)
        } else {
            let approval_id = self.approvals.create_tool_approval(&tool_name).await?;
            let status = self
                .approvals
                .wait_tool_approval(&approval_id, self.cancel.clone())
                .await?;
            let decision = match status.clone() {
                ApprovalStatus::Approved => PermissionDecision::allow(input),
                ApprovalStatus::Denied { reason } => PermissionDecision::deny(format!(
                    "Denied by user: {}",
                    reason.unwrap_or_default()
                )),
                ApprovalStatus::TimedOut => {
                    PermissionDecision::deny("Approval request timed out".into())
                }
                ApprovalStatus::Pending => {
                    PermissionDecision::deny("Approval still pending".into())
                }
            };
            let payload = serde_json::json!({
                "type": "approval_response",
                "tool_name": tool_name,
                "approval_id": approval_id,
                "status": status.as_str(),
            });
            (decision, payload)
        };

        Ok(PermissionDecision {
            log_payload: Some(log_payload),
            ..decision
        })
    }

    pub async fn on_hook_callback(&self) -> Value {
        if self.manual {
            serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": "Forwarding to approval flow",
                }
            })
        } else {
            serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "Auto-approved",
                }
            })
        }
    }
}

pub struct PermissionDecision {
    pub result: PermissionResult,
    pub log_payload: Option<Value>,
}

impl PermissionDecision {
    fn allow(updated_input: Value) -> Self {
        Self {
            result: PermissionResult::Allow {
                updated_input,
                updated_permissions: None,
            },
            log_payload: None,
        }
    }

    fn deny(message: String) -> Self {
        Self {
            result: PermissionResult::Deny {
                message,
                interrupt: Some(false),
            },
            log_payload: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "behavior", rename_all = "camelCase")]
pub enum PermissionResult {
    Allow {
        #[serde(rename = "updatedInput")]
        updated_input: Value,
        #[serde(rename = "updatedPermissions", skip_serializing_if = "Option::is_none")]
        updated_permissions: Option<Vec<PermissionUpdate>>,
    },
    Deny {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        interrupt: Option<bool>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionUpdate {
    #[serde(rename = "type")]
    pub update_type: PermissionUpdateType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<PermissionMode>,
    pub destination: PermissionUpdateDestination,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionUpdateType {
    SetMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionUpdateDestination {
    Session,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CLIMessage {
    ControlRequest {
        request_id: String,
        request: ControlRequestType,
    },
    ControlResponse {
        #[allow(dead_code)]
        response: ControlResponseType,
    },
    Result(Value),
    #[serde(other)]
    Other,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlRequestType {
    CanUseTool {
        tool_name: String,
        input: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        permission_suggestions: Option<Vec<PermissionUpdate>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
    },
    HookCallback {
        callback_id: String,
        input: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlResponseType {
    Success {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        response: Option<Value>,
    },
    Error {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct SDKControlRequestMessage {
    #[serde(rename = "type")]
    message_type: &'static str,
    pub request_id: String,
    pub request: SDKControlRequestType,
}

impl SDKControlRequestMessage {
    fn new(request: SDKControlRequestType) -> Self {
        Self {
            message_type: "control_request",
            request_id: uuid::Uuid::new_v4().to_string(),
            request,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum SDKControlRequestType {
    Initialize {
        #[serde(skip_serializing_if = "Option::is_none")]
        hooks: Option<Value>,
    },
    SetPermissionMode {
        mode: PermissionMode,
    },
}

pub struct ClaudeProtocolPeer {
    stdin: Arc<Mutex<ChildStdin>>,
    client: Arc<ClaudeAgentClient>,
    logger: ClaudeLogEmitter,
    config: PermissionRuntimeConfig,
}

impl ClaudeProtocolPeer {
    pub fn new(
        stdin: ChildStdin,
        client: Arc<ClaudeAgentClient>,
        logger: ClaudeLogEmitter,
        config: PermissionRuntimeConfig,
    ) -> Arc<Self> {
        Arc::new(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            client,
            logger,
            config,
        })
    }

    pub async fn initialize(&self) -> Result<(), ContainerError> {
        self.send_json(&SDKControlRequestMessage::new(
            SDKControlRequestType::Initialize {
                hooks: self.config.hooks.clone(),
            },
        ))
        .await?;
        self.send_json(&SDKControlRequestMessage::new(
            SDKControlRequestType::SetPermissionMode {
                mode: self.config.mode,
            },
        ))
        .await?;
        Ok(())
    }

    pub async fn try_consume_line(&self, line: &str) -> Result<bool, ContainerError> {
        match serde_json::from_str::<CLIMessage>(line) {
            Ok(CLIMessage::ControlRequest {
                request_id,
                request,
            }) => {
                self.handle_control_request(request_id, request).await?;
                Ok(true)
            }
            Ok(CLIMessage::ControlResponse { .. }) => Ok(true),
            _ => Ok(false),
        }
    }

    async fn handle_control_request(
        &self,
        request_id: String,
        request: ControlRequestType,
    ) -> Result<(), ContainerError> {
        match request {
            ControlRequestType::CanUseTool {
                tool_name,
                input,
                permission_suggestions: _,
                tool_use_id,
            } => {
                let decision = self
                    .client
                    .on_can_use_tool(tool_name.clone(), input, tool_use_id)
                    .await
                    .map_err(|err| ContainerError::Other(anyhow!(err)))?;

                if let Some(payload) = &decision.log_payload {
                    self.logger.log_json(payload).await;
                }

                let mut result = decision.result;
                if matches!(result, PermissionResult::Allow { .. }) && tool_name == EXIT_PLAN_MODE {
                    if let PermissionResult::Allow {
                        ref mut updated_permissions,
                        ..
                    } = result
                    {
                        let update = PermissionUpdate {
                            update_type: PermissionUpdateType::SetMode,
                            mode: Some(PermissionMode::BypassPermissions),
                            destination: PermissionUpdateDestination::Session,
                        };
                        match updated_permissions {
                            Some(list) => list.push(update),
                            None => *updated_permissions = Some(vec![update]),
                        }
                    }
                }

                self.send_response(ControlResponseType::Success {
                    request_id,
                    response: Some(
                        serde_json::to_value(result)
                            .map_err(|err| ContainerError::Other(anyhow!(err)))?,
                    ),
                })
                .await
            }
            ControlRequestType::HookCallback { .. } => {
                let payload = self.client.on_hook_callback().await;
                self.send_response(ControlResponseType::Success {
                    request_id,
                    response: Some(payload),
                })
                .await
            }
        }
    }

    async fn send_response(&self, response: ControlResponseType) -> Result<(), ContainerError> {
        self.send_json(&ControlResponseMessage::new(response)).await
    }

    async fn send_json<T: Serialize>(&self, message: &T) -> Result<(), ContainerError> {
        let json =
            serde_json::to_string(message).map_err(|err| ContainerError::Other(anyhow!(err)))?;
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(json.as_bytes())
            .await
            .map_err(ContainerError::Io)?;
        stdin.write_all(b"\n").await.map_err(ContainerError::Io)?;
        stdin.flush().await.map_err(ContainerError::Io)?;
        Ok(())
    }

    pub async fn send_user_message(&self, content: &str) -> Result<(), ContainerError> {
        let message = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": content
            }
        });
        self.send_json(&message).await
    }
}

#[derive(Debug, Serialize)]
pub struct ControlResponseMessage {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub response: ControlResponseType,
}

impl ControlResponseMessage {
    pub fn new(response: ControlResponseType) -> Self {
        Self {
            message_type: "control_response",
            response,
        }
    }
}
