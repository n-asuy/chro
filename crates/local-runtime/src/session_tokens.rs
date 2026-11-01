//! Per-turn credentials for agents calling back into chro.
//!
//! Every turn chro starts gets a fresh random token in its environment. The
//! operator API maps a presented token back to the session and turn it was
//! issued for, which is how the server knows *which* agent is calling without
//! trusting anything the caller says about itself. A token dies with its turn,
//! so a process left behind after the turn ended can no longer act.

use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};

use uuid::Uuid;

/// What a valid session token stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionGrant {
    pub task_id: Uuid,
    pub run_id: Uuid,
}

#[derive(Clone, Default)]
pub struct SessionTokens {
    grants: Arc<RwLock<HashMap<String, SessionGrant>>>,
}

impl SessionTokens {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a token for one turn. 244 random bits from two v4 UUIDs.
    pub fn issue(&self, task_id: Uuid, run_id: Uuid) -> String {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        self.grants
            .write()
            .expect("session token lock")
            .insert(token.clone(), SessionGrant { task_id, run_id });
        token
    }

    pub fn resolve(&self, token: &str) -> Option<SessionGrant> {
        self.grants
            .read()
            .expect("session token lock")
            .get(token)
            .copied()
    }

    /// Invalidate every token issued for `run_id`.
    pub fn revoke_run(&self, run_id: Uuid) {
        self.grants
            .write()
            .expect("session token lock")
            .retain(|_, grant| grant.run_id != run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_resolves_to_the_turn_it_was_issued_for() {
        let tokens = SessionTokens::new();
        let (task_id, run_id) = (Uuid::new_v4(), Uuid::new_v4());
        let token = tokens.issue(task_id, run_id);
        assert_eq!(tokens.resolve(&token), Some(SessionGrant { task_id, run_id }));
    }

    #[test]
    fn tokens_are_unique_and_unguessable_in_length() {
        let tokens = SessionTokens::new();
        let a = tokens.issue(Uuid::new_v4(), Uuid::new_v4());
        let b = tokens.issue(Uuid::new_v4(), Uuid::new_v4());
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn ending_a_turn_revokes_only_its_tokens() {
        let tokens = SessionTokens::new();
        let task_id = Uuid::new_v4();
        let (ended, live) = (Uuid::new_v4(), Uuid::new_v4());
        let ended_token = tokens.issue(task_id, ended);
        let live_token = tokens.issue(task_id, live);

        tokens.revoke_run(ended);

        assert_eq!(tokens.resolve(&ended_token), None);
        assert!(tokens.resolve(&live_token).is_some());
    }

    #[test]
    fn unknown_tokens_resolve_to_nothing() {
        assert_eq!(SessionTokens::new().resolve("nope"), None);
    }
}
