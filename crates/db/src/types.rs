use serde::{Deserialize, Serialize};
use sqlx::{
    encode::IsNull,
    error::BoxDynError,
    sqlite::{SqliteArgumentValue, SqliteTypeInfo, SqliteValueRef},
    Decode, Encode, Sqlite, Type,
};
use ts_rs::TS;

/// Execution mode for task runs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "execution-mode.ts")]
#[serde(rename_all = "lowercase")]
pub enum ExecutionMode {
    Local,
    Remote,
}

impl Type<Sqlite> for ExecutionMode {
    fn type_info() -> SqliteTypeInfo {
        <String as Type<Sqlite>>::type_info()
    }
}

impl<'q> Encode<'q, Sqlite> for ExecutionMode {
    fn encode_by_ref(
        &self,
        args: &mut Vec<SqliteArgumentValue<'q>>,
    ) -> Result<IsNull, BoxDynError> {
        let s = match self {
            ExecutionMode::Local => "local",
            ExecutionMode::Remote => "remote",
        };
        args.push(SqliteArgumentValue::Text(s.into()));
        Ok(IsNull::No)
    }
}

impl<'r> Decode<'r, Sqlite> for ExecutionMode {
    fn decode(value: SqliteValueRef<'r>) -> Result<Self, BoxDynError> {
        let s = <&str as Decode<Sqlite>>::decode(value)?;
        match s {
            "local" => Ok(ExecutionMode::Local),
            "remote" => Ok(ExecutionMode::Remote),
            _ => Err(format!("Invalid execution mode: {}", s).into()),
        }
    }
}

/// Task record status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "task-status.ts")]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Cancelled,
}

impl Type<Sqlite> for TaskStatus {
    fn type_info() -> SqliteTypeInfo {
        <String as Type<Sqlite>>::type_info()
    }
}

impl<'q> Encode<'q, Sqlite> for TaskStatus {
    fn encode_by_ref(
        &self,
        args: &mut Vec<SqliteArgumentValue<'q>>,
    ) -> Result<IsNull, BoxDynError> {
        let s = match self {
            TaskStatus::Pending => "pending",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
        };
        args.push(SqliteArgumentValue::Text(s.into()));
        Ok(IsNull::No)
    }
}

impl<'r> Decode<'r, Sqlite> for TaskStatus {
    fn decode(value: SqliteValueRef<'r>) -> Result<Self, BoxDynError> {
        let s = <&str as Decode<Sqlite>>::decode(value)?;
        match s {
            "pending" => Ok(TaskStatus::Pending),
            "in_progress" => Ok(TaskStatus::InProgress),
            "completed" => Ok(TaskStatus::Completed),
            "failed" => Ok(TaskStatus::Failed),
            "cancelled" => Ok(TaskStatus::Cancelled),
            _ => Err(format!("Invalid task status: {}", s).into()),
        }
    }
}

/// Task run status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "run-status.ts")]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl Type<Sqlite> for RunStatus {
    fn type_info() -> SqliteTypeInfo {
        <String as Type<Sqlite>>::type_info()
    }
}

impl<'q> Encode<'q, Sqlite> for RunStatus {
    fn encode_by_ref(
        &self,
        args: &mut Vec<SqliteArgumentValue<'q>>,
    ) -> Result<IsNull, BoxDynError> {
        let s = match self {
            RunStatus::Pending => "pending",
            RunStatus::Running => "running",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
        };
        args.push(SqliteArgumentValue::Text(s.into()));
        Ok(IsNull::No)
    }
}

impl<'r> Decode<'r, Sqlite> for RunStatus {
    fn decode(value: SqliteValueRef<'r>) -> Result<Self, BoxDynError> {
        let s = <&str as Decode<Sqlite>>::decode(value)?;
        match s {
            "pending" => Ok(RunStatus::Pending),
            "running" => Ok(RunStatus::Running),
            "completed" => Ok(RunStatus::Completed),
            "failed" => Ok(RunStatus::Failed),
            "cancelled" => Ok(RunStatus::Cancelled),
            _ => Err(format!("Invalid run status: {}", s).into()),
        }
    }
}

/// Draft type for task drafts
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "draft-type.ts")]
#[serde(rename_all = "snake_case")]
pub enum DraftType {
    Initial,
    Retry,
    FollowUp,
}

impl Type<Sqlite> for DraftType {
    fn type_info() -> SqliteTypeInfo {
        <String as Type<Sqlite>>::type_info()
    }
}

impl<'q> Encode<'q, Sqlite> for DraftType {
    fn encode_by_ref(
        &self,
        args: &mut Vec<SqliteArgumentValue<'q>>,
    ) -> Result<IsNull, BoxDynError> {
        let s = match self {
            DraftType::Initial => "initial",
            DraftType::Retry => "retry",
            DraftType::FollowUp => "follow_up",
        };
        args.push(SqliteArgumentValue::Text(s.into()));
        Ok(IsNull::No)
    }
}

impl<'r> Decode<'r, Sqlite> for DraftType {
    fn decode(value: SqliteValueRef<'r>) -> Result<Self, BoxDynError> {
        let s = <&str as Decode<Sqlite>>::decode(value)?;
        match s {
            "initial" => Ok(DraftType::Initial),
            "retry" => Ok(DraftType::Retry),
            "follow_up" => Ok(DraftType::FollowUp),
            _ => Err(format!("Invalid draft type: {}", s).into()),
        }
    }
}

/// Recurrence status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "recurrence-status.ts")]
#[serde(rename_all = "snake_case")]
pub enum RecurrenceStatus {
    Active,
    Paused,
    Completed,
}

impl Type<Sqlite> for RecurrenceStatus {
    fn type_info() -> SqliteTypeInfo {
        <String as Type<Sqlite>>::type_info()
    }
}

impl<'q> Encode<'q, Sqlite> for RecurrenceStatus {
    fn encode_by_ref(
        &self,
        args: &mut Vec<SqliteArgumentValue<'q>>,
    ) -> Result<IsNull, BoxDynError> {
        let s = match self {
            RecurrenceStatus::Active => "active",
            RecurrenceStatus::Paused => "paused",
            RecurrenceStatus::Completed => "completed",
        };
        args.push(SqliteArgumentValue::Text(s.into()));
        Ok(IsNull::No)
    }
}

impl<'r> Decode<'r, Sqlite> for RecurrenceStatus {
    fn decode(value: SqliteValueRef<'r>) -> Result<Self, BoxDynError> {
        let s = <&str as Decode<Sqlite>>::decode(value)?;
        match s {
            "active" => Ok(RecurrenceStatus::Active),
            "paused" => Ok(RecurrenceStatus::Paused),
            "completed" => Ok(RecurrenceStatus::Completed),
            _ => Err(format!("Invalid recurrence status: {}", s).into()),
        }
    }
}

/// Merge record type (direct merge commit or pull request tracking)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "merge-type.ts")]
#[serde(rename_all = "snake_case")]
pub enum MergeType {
    Direct,
    Pr,
}

impl MergeType {
    fn as_str(&self) -> &'static str {
        match self {
            MergeType::Direct => "direct",
            MergeType::Pr => "pr",
        }
    }
}

impl Type<Sqlite> for MergeType {
    fn type_info() -> SqliteTypeInfo {
        <String as Type<Sqlite>>::type_info()
    }
}

impl<'q> Encode<'q, Sqlite> for MergeType {
    fn encode_by_ref(
        &self,
        args: &mut Vec<SqliteArgumentValue<'q>>,
    ) -> Result<IsNull, BoxDynError> {
        args.push(SqliteArgumentValue::Text(self.as_str().into()));
        Ok(IsNull::No)
    }
}

impl<'r> Decode<'r, Sqlite> for MergeType {
    fn decode(value: SqliteValueRef<'r>) -> Result<Self, BoxDynError> {
        let s = <&str as Decode<Sqlite>>::decode(value)?;
        match s {
            "direct" => Ok(MergeType::Direct),
            "pr" => Ok(MergeType::Pr),
            other => Err(format!("invalid merge type: {other}").into()),
        }
    }
}

/// Status for tracked pull request merges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "merge-status.ts")]
#[serde(rename_all = "snake_case")]
pub enum MergeStatus {
    Open,
    Merged,
    Closed,
}

impl MergeStatus {
    fn as_str(&self) -> &'static str {
        match self {
            MergeStatus::Open => "open",
            MergeStatus::Merged => "merged",
            MergeStatus::Closed => "closed",
        }
    }
}

impl Type<Sqlite> for MergeStatus {
    fn type_info() -> SqliteTypeInfo {
        <String as Type<Sqlite>>::type_info()
    }
}

impl<'q> Encode<'q, Sqlite> for MergeStatus {
    fn encode_by_ref(
        &self,
        args: &mut Vec<SqliteArgumentValue<'q>>,
    ) -> Result<IsNull, BoxDynError> {
        args.push(SqliteArgumentValue::Text(self.as_str().into()));
        Ok(IsNull::No)
    }
}

impl<'r> Decode<'r, Sqlite> for MergeStatus {
    fn decode(value: SqliteValueRef<'r>) -> Result<Self, BoxDynError> {
        let s = <&str as Decode<Sqlite>>::decode(value)?;
        match s {
            "open" => Ok(MergeStatus::Open),
            "merged" => Ok(MergeStatus::Merged),
            "closed" => Ok(MergeStatus::Closed),
            other => Err(format!("invalid merge status: {other}").into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execution_mode_serialization() {
        assert_eq!(
            serde_json::to_string(&ExecutionMode::Local).unwrap(),
            "\"local\""
        );
        assert_eq!(
            serde_json::to_string(&ExecutionMode::Remote).unwrap(),
            "\"remote\""
        );
    }

    #[test]
    fn test_task_status_serialization() {
        assert_eq!(
            serde_json::to_string(&TaskStatus::InProgress).unwrap(),
            "\"in_progress\""
        );
    }
}
