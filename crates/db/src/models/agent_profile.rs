use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{FromRow, Pool, Sqlite};
use ts_rs::TS;
use uuid::Uuid;

/// Agent profile (human or LLM agent)
///
/// Represents an agent that can work on tasks, including both human users
/// and AI assistants.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "agent-profile.ts")]
pub struct AgentProfile {
    pub id: Uuid,
    pub provider: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub agent_type: String,
    #[ts(type = "Record<string, unknown> | null")]
    pub capabilities: Option<JsonValue>,
    pub owner_user_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl AgentProfile {
    /// Create a new human agent profile
    pub fn new_human(owner_user_id: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            provider: None,
            model: None,
            agent_type: "human".to_string(),
            capabilities: None,
            owner_user_id: Some(owner_user_id.into()),
            created_at: now,
            updated_at: now,
        }
    }

    /// Create a new LLM agent profile
    pub fn new_llm(
        provider: impl Into<String>,
        model: impl Into<String>,
        capabilities: Option<JsonValue>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            provider: Some(provider.into()),
            model: Some(model.into()),
            agent_type: "llm".to_string(),
            capabilities,
            owner_user_id: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Ensure the default desktop agent profile exists and return its id.
    pub async fn ensure_default_desktop_profile(pool: &Pool<Sqlite>) -> Result<Uuid, sqlx::Error> {
        let id = Uuid::from_u128(0x42);
        let exists =
            sqlx::query_scalar::<_, i64>("SELECT 1 FROM agent_profiles WHERE id = ? LIMIT 1")
                .bind(id)
                .fetch_optional(pool)
                .await?
                .is_some();

        if !exists {
            sqlx::query("DELETE FROM agent_profiles WHERE id = ?")
                .bind(id)
                .execute(pool)
                .await?;

            let now = Utc::now();
            sqlx::query(
                "INSERT INTO agent_profiles (id, provider, model, type, capabilities, owner_user_id, created_at, updated_at)
                 VALUES (?, 'anthropic', 'claude-desktop', 'llm', NULL, NULL, ?, ?)",
            )
            .bind(id)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await?;
        }

        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_human_agent_creation() {
        let agent = AgentProfile::new_human("user123");
        assert_eq!(agent.agent_type, "human");
        assert_eq!(agent.owner_user_id, Some("user123".to_string()));
        assert!(agent.provider.is_none());
    }

    #[test]
    fn test_llm_agent_creation() {
        let agent = AgentProfile::new_llm("anthropic", "claude-3", None);
        assert_eq!(agent.agent_type, "llm");
        assert_eq!(agent.provider, Some("anthropic".to_string()));
        assert_eq!(agent.model, Some("claude-3".to_string()));
    }
}
