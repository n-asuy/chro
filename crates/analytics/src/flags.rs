//! Feature-flag registry.
//!
//! The registry is the single source of truth for *which* flags exist, who
//! owns them, and when they must be retired. PostHog only holds the rollout
//! state (who gets a flag at what percentage); it never decides which flags
//! exist. Keeping the ledger in code means a flag and the branch it guards
//! live together, so they cannot drift apart.
//!
//! Lifecycle is enforced by tests, not discipline:
//! - `retire_by_dates_are_in_the_future` fails CI once a flag is past its
//!   retire-by date, forcing a decision (graduate the code or delete it).
//! - `generate_flags_doc` regenerates `FLAGS.md`; CI can `git diff --exit-code`
//!   to ensure the human-readable ledger stays in sync with the code.
//!
//! Privacy: flag resolution contacts PostHog only when telemetry is enabled.
//! Opted-out users always receive each flag's `default_enabled` value and no
//! network request is made on their behalf.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::Ordering;

use serde::Serialize;
use serde_json::{json, Value};
use strum::IntoEnumIterator;
use strum_macros::EnumIter;
use tracing::debug;

/// Where a flag sits in its lifecycle. Every flag eventually leaves the
/// registry: `Graduated` (the feature won, fold it into the code and delete
/// the flag) or `Killed` (the feature lost, delete the feature and the flag).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Off by default, behind a flag, being measured.
    Experimental,
    /// Being ramped from a small cohort toward everyone.
    RollingOut,
    /// Won. Pending removal of the flag (code becomes unconditional).
    Graduated,
    /// Lost. Pending removal of the feature and the flag.
    Killed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Experimental => "experimental",
            Status::RollingOut => "rolling_out",
            Status::Graduated => "graduated",
            Status::Killed => "killed",
        }
    }
}

/// Every feature flag known to the application.
///
/// To add a flag: add a variant here and a matching arm in [`Flag::meta`]. The
/// compiler forces the metadata to exist, and the tests force a valid key and a
/// future retire-by date. To remove a flag: delete the variant (and its guarded
/// branch); `FLAGS.md` regenerates on the next `cargo test`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter)]
pub enum Flag {
    SessionReferencesPopover,
}

/// Static description of a flag. The `key` is the identifier shared with
/// PostHog and the renderer.
#[derive(Debug, Clone, Serialize)]
pub struct FlagMeta {
    pub key: &'static str,
    pub owner: &'static str,
    /// Creation date, `YYYY-MM-DD`.
    pub created: &'static str,
    /// Retire-by date, `YYYY-MM-DD`. The lifecycle test fails once this is past.
    pub retire_by: &'static str,
    /// Value used when PostHog is unreachable or telemetry is disabled.
    pub default_enabled: bool,
    pub status: Status,
    pub description: &'static str,
}

impl Flag {
    /// The flag key shared with PostHog and the renderer.
    pub fn key(self) -> &'static str {
        self.meta().key
    }

    pub fn meta(self) -> FlagMeta {
        match self {
            Flag::SessionReferencesPopover => FlagMeta {
                key: "session_references_popover",
                owner: "@n-asuy",
                created: "2026-06-14",
                retire_by: "2026-09-01",
                // Existing feature: default on so gating never removes it for
                // anyone (telemetry-off users always get the default). PostHog
                // and the dev panel can flip it off to measure/disable.
                default_enabled: true,
                status: Status::RollingOut,
                description: "Show the task references popover (Uses / Referenced by) in the session composer.",
            },
        }
    }
}

/// Metadata for every flag, sorted by key. Drives the generated `FLAGS.md` and
/// the in-app developer panel.
pub fn registry() -> Vec<FlagMeta> {
    let mut metas: Vec<FlagMeta> = Flag::iter().map(Flag::meta).collect();
    metas.sort_by(|a, b| a.key.cmp(b.key));
    metas
}

/// Resolve every flag to an effective boolean for the current installation.
///
/// Each flag starts at its `default_enabled` value; PostHog rollout state is
/// overlaid on top when telemetry is enabled. Any failure (uninitialized,
/// disabled, network error) yields defaults, so flag resolution never blocks
/// or breaks startup.
pub async fn resolve_all() -> BTreeMap<String, bool> {
    let mut resolved: BTreeMap<String, bool> = Flag::iter()
        .map(|flag| {
            let meta = flag.meta();
            (meta.key.to_string(), meta.default_enabled)
        })
        .collect();

    // Privacy: never contact PostHog when the user has opted out of telemetry.
    if !super::ENABLED.load(Ordering::SeqCst) {
        return resolved;
    }

    let Some(analytics) = super::INSTANCE.get() else {
        return resolved;
    };

    match fetch_decide(analytics).await {
        Ok(remote) => {
            for (key, value) in resolved.iter_mut() {
                if let Some(remote_value) = remote.get(key) {
                    *value = *remote_value;
                }
            }
        }
        Err(e) => debug!("feature flag resolve failed, using defaults: {e}"),
    }

    resolved
}

/// Ask PostHog for the flag values for this `distinct_id`.
async fn fetch_decide(analytics: &super::Analytics) -> Result<HashMap<String, bool>, reqwest::Error> {
    let payload = json!({
        "api_key": analytics.api_key,
        "distinct_id": analytics.distinct_id,
    });

    let body: Value = analytics
        .client
        .post(format!("{}/decide/?v=3", super::POSTHOG_HOST))
        .json(&payload)
        .timeout(super::REQUEST_TIMEOUT)
        .send()
        .await?
        .json()
        .await?;

    let mut out = HashMap::new();
    if let Some(flags) = body.get("featureFlags").and_then(Value::as_object) {
        for (key, value) in flags {
            let enabled = match value {
                Value::Bool(b) => *b,
                // A multivariate flag returns a non-empty variant string when on.
                Value::String(s) => !s.is_empty(),
                _ => false,
            };
            out.insert(key.clone(), enabled);
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn keys_are_unique_and_well_formed() {
        let mut seen = HashSet::new();
        for meta in registry() {
            assert!(
                seen.insert(meta.key),
                "duplicate flag key: {}",
                meta.key
            );
            assert!(
                !meta.key.is_empty()
                    && meta
                        .key
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "flag key must be snake_case ascii: {}",
                meta.key
            );
            assert!(!meta.owner.is_empty(), "flag {} has no owner", meta.key);
            assert!(
                !meta.description.is_empty(),
                "flag {} has no description",
                meta.key
            );
        }
    }

    #[test]
    fn dates_parse() {
        for meta in registry() {
            chrono::NaiveDate::parse_from_str(meta.created, "%Y-%m-%d")
                .unwrap_or_else(|_| panic!("flag {} has invalid created date", meta.key));
            chrono::NaiveDate::parse_from_str(meta.retire_by, "%Y-%m-%d")
                .unwrap_or_else(|_| panic!("flag {} has invalid retire_by date", meta.key));
        }
    }

    /// Lifecycle enforcement: a flag past its retire-by date fails CI. When this
    /// fires, decide the flag's fate (graduate the code or delete the feature),
    /// remove the variant, and regenerate `FLAGS.md`. Do not just bump the date
    /// without a reason.
    #[test]
    fn retire_by_dates_are_in_the_future() {
        let today = chrono::Utc::now().date_naive();
        let overdue: Vec<String> = registry()
            .into_iter()
            .filter_map(|meta| {
                let retire = chrono::NaiveDate::parse_from_str(meta.retire_by, "%Y-%m-%d").ok()?;
                (retire < today).then(|| format!("{} (retire_by {})", meta.key, meta.retire_by))
            })
            .collect();

        assert!(
            overdue.is_empty(),
            "flags past their retire-by date must be graduated or deleted: {}",
            overdue.join(", ")
        );
    }

    #[test]
    fn resolve_all_returns_defaults_when_uninitialized() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let resolved = rt.block_on(resolve_all());
        for meta in registry() {
            assert_eq!(
                resolved.get(meta.key),
                Some(&meta.default_enabled),
                "uninitialized resolve should return the default for {}",
                meta.key
            );
        }
    }

    /// Regenerates `crates/analytics/FLAGS.md` from the registry. This is the
    /// human-readable ledger (the "list view") and is always derived, never
    /// hand-edited. CI can run `cargo test` then `git diff --exit-code` to catch
    /// a stale doc.
    #[test]
    fn generate_flags_doc() {
        let mut out = String::new();
        out.push_str("# Feature flags\n\n");
        out.push_str(
            "<!-- Generated by `cargo test -p analytics`. Do not edit by hand. -->\n",
        );
        out.push_str(
            "<!-- Source of truth: crates/analytics/src/flags.rs -->\n\n",
        );
        out.push_str("| Key | Status | Owner | Created | Retire by | Default | Description |\n");
        out.push_str("| --- | --- | --- | --- | --- | --- | --- |\n");
        for meta in registry() {
            out.push_str(&format!(
                "| `{}` | {} | {} | {} | {} | {} | {} |\n",
                meta.key,
                meta.status.as_str(),
                meta.owner,
                meta.created,
                meta.retire_by,
                if meta.default_enabled { "on" } else { "off" },
                meta.description,
            ));
        }

        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/FLAGS.md");
        std::fs::write(path, out).expect("write FLAGS.md");
    }
}
