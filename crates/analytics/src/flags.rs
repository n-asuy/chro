//! Feature-flag registry.
//!
//! The registry is the single source of truth for *which* flags exist, who
//! owns them, and when they must be retired. It never decides which flags
//! exist. Keeping the ledger in code means a flag and the branch it guards
//! live together, so they cannot drift apart.
//!
//! Each flag also declares who owns its *rollout* (see [`Rollout`]). The
//! default is `Local`: the code decides, and PostHog is not consulted. A flag
//! opts into `Remote` only when a rollout is actually being run, because that
//! is the moment the repo stops telling you the flag's value. Without this,
//! stale dashboard state silently outranks `default_enabled` and the generated
//! ledger below quietly becomes a lie.
//!
//! Lifecycle is enforced by tests, not discipline:
//! - `retire_by_dates_are_in_the_future` fails CI once a flag is past its
//!   retire-by date, forcing a decision (graduate the code or delete it).
//! - `generate_flags_doc` regenerates `FLAGS.md` and `generate_flag_keys_ts`
//!   regenerates the renderer's `flags.generated.ts`; CI can
//!   `git diff --exit-code` to ensure both derived artifacts stay in sync with
//!   the code.
//!
//! Privacy: flag resolution contacts PostHog only when at least one flag is
//! `Remote` *and* telemetry is enabled. Opted-out users, and every user of an
//! all-local registry, receive each flag's `default_enabled` value with no
//! network request made on their behalf.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::Ordering;

use serde_json::{json, Value};
use strum::IntoEnumIterator;
use strum_macros::EnumIter;
use tracing::debug;

/// Where a flag sits in its lifecycle. Every flag eventually leaves the
/// registry: `Graduated` (the feature won, fold it into the code and delete
/// the flag) or `Killed` (the feature lost, delete the feature and the flag).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// Who decides whether a flag is on for a given installation.
///
/// This is the flag's *rollout owner*, which is a separate axis from [`Status`]
/// (its lifecycle stage). A flag can be `Experimental` and still be `Local`:
/// it is dark, and the code is what keeps it dark.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rollout {
    /// The code decides. PostHog is never consulted for this flag, so
    /// `default_enabled` *is* the value and editing it actually changes
    /// behaviour. The registry is then the whole truth.
    Local,
    /// PostHog decides who gets it and at what percentage. `default_enabled`
    /// degrades to a fallback for when PostHog is unreachable or telemetry is
    /// off. Choose this only when a rollout is actually being run: it means the
    /// repo no longer tells you the flag's value.
    ///
    /// Turning a flag *off* in PostHog has two forms, and they are not
    /// equivalent here. Both were observed against the real project on
    /// 2026-07-15:
    /// - **Disabling** the flag drops the key from `/decide` entirely
    ///   (`featureFlags: {}`). PostHog then has no opinion and
    ///   `default_enabled` decides, so a kill switch built this way is inert
    ///   whenever `default_enabled` is `true`.
    /// - **Keeping it enabled at 0%** returns an explicit `false`, which wins
    ///   regardless of `default_enabled`.
    ///
    /// So: to kill a `Remote` flag, ramp it to 0% rather than disabling it.
    /// Disabling only appears to work while `default_enabled` happens to be
    /// `false`, which makes it a trap rather than a kill switch.
    Remote,
}

impl Rollout {
    pub fn as_str(self) -> &'static str {
        match self {
            Rollout::Local => "local",
            Rollout::Remote => "remote",
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
#[derive(Debug, Clone)]
pub struct FlagMeta {
    pub key: &'static str,
    pub owner: &'static str,
    /// Creation date, `YYYY-MM-DD`.
    pub created: &'static str,
    /// Retire-by date, `YYYY-MM-DD`. The lifecycle test fails once this is past.
    pub retire_by: &'static str,
    /// The flag's value under [`Rollout::Local`]; under [`Rollout::Remote`],
    /// the fallback for when PostHog is unreachable or telemetry is disabled.
    pub default_enabled: bool,
    pub rollout: Rollout,
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
                // Fallback only, and deliberately dark: users we cannot reach
                // (telemetry off) or answer for (PostHog down) should not be
                // handed a feature that is still being rolled out.
                default_enabled: false,
                // Remote: this flag is the rehearsal for operating the kill
                // switch, which is the property a shipped desktop binary cannot
                // get any other way. PostHog decides, so `default_enabled`
                // above is a fallback and not the value.
                rollout: Rollout::Remote,
                // Under active rollout management: PostHog holds it at 0% and
                // it is ramped from there. Not `experimental`, which claims the
                // flag is being measured; the app emits no usage events at all,
                // so nothing about this flag is measurable yet.
                status: Status::RollingOut,
                description: "Show the task references popover (Uses / Referenced by) in the session composer.",
            },
        }
    }
}

/// Metadata for every flag, sorted by key. Drives the generated `FLAGS.md`,
/// the generated `flags.generated.ts`, and the in-app developer panel.
pub fn registry() -> Vec<FlagMeta> {
    let mut metas: Vec<FlagMeta> = Flag::iter().map(Flag::meta).collect();
    metas.sort_by(|a, b| a.key.cmp(b.key));
    metas
}

/// Overlay PostHog's answer onto the resolved values.
///
/// Only [`Rollout::Remote`] flags are touched. A `Local` flag is ignored even
/// when PostHog has an opinion about its key, so stale dashboard state left
/// over from an old experiment cannot quietly contradict the registry.
fn apply_remote(
    metas: &[FlagMeta],
    resolved: &mut BTreeMap<String, bool>,
    remote: &HashMap<String, bool>,
) {
    for meta in metas {
        if meta.rollout != Rollout::Remote {
            continue;
        }
        if let Some(remote_value) = remote.get(meta.key) {
            resolved.insert(meta.key.to_string(), *remote_value);
        }
    }
}

/// Resolve every flag to an effective boolean for the current installation.
///
/// Each flag starts at its `default_enabled` value. Flags that delegate their
/// rollout ([`Rollout::Remote`]) then take PostHog's answer when telemetry is
/// enabled. Any failure (uninitialized, disabled, network error) yields
/// defaults, so flag resolution never blocks or breaks startup.
pub async fn resolve_all() -> BTreeMap<String, bool> {
    let metas = registry();
    let mut resolved: BTreeMap<String, bool> = metas
        .iter()
        .map(|meta| (meta.key.to_string(), meta.default_enabled))
        .collect();

    // Nothing delegates its rollout, so PostHog has nothing to tell us. This
    // also means an all-local registry makes no flag network call at all, even
    // for users who have telemetry on.
    if !metas.iter().any(|meta| meta.rollout == Rollout::Remote) {
        return resolved;
    }

    // Privacy: never contact PostHog when the user has opted out of telemetry.
    if !super::ENABLED.load(Ordering::SeqCst) {
        return resolved;
    }

    let Some(analytics) = super::INSTANCE.get() else {
        return resolved;
    };

    match fetch_decide(analytics).await {
        Ok(remote) => apply_remote(&metas, &mut resolved, &remote),
        Err(e) => debug!("feature flag resolve failed, using defaults: {e}"),
    }

    resolved
}

/// Ask PostHog for the flag values for this `distinct_id`.
async fn fetch_decide(
    analytics: &super::Analytics,
) -> Result<HashMap<String, bool>, reqwest::Error> {
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
            assert!(seen.insert(meta.key), "duplicate flag key: {}", meta.key);
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

    fn meta_for_test(key: &'static str, default_enabled: bool, rollout: Rollout) -> FlagMeta {
        FlagMeta {
            key,
            owner: "@someone",
            created: "2026-01-01",
            retire_by: "2099-01-01",
            default_enabled,
            rollout,
            status: Status::Experimental,
            description: "test flag",
        }
    }

    fn resolve_with(metas: &[FlagMeta], remote: &[(&str, bool)]) -> BTreeMap<String, bool> {
        let mut resolved: BTreeMap<String, bool> = metas
            .iter()
            .map(|meta| (meta.key.to_string(), meta.default_enabled))
            .collect();
        let remote: HashMap<String, bool> = remote
            .iter()
            .map(|(key, value)| ((*key).to_string(), *value))
            .collect();
        apply_remote(metas, &mut resolved, &remote);
        resolved
    }

    #[test]
    fn remote_flags_take_posthogs_answer() {
        let metas = [meta_for_test("remote_flag", false, Rollout::Remote)];

        let resolved = resolve_with(&metas, &[("remote_flag", true)]);

        assert_eq!(resolved.get("remote_flag"), Some(&true));
    }

    /// The whole point of `Rollout::Local`: editing `default_enabled` changes
    /// behaviour, and dashboard state cannot silently contradict the registry.
    #[test]
    fn local_flags_ignore_posthog_entirely() {
        let metas = [meta_for_test("local_flag", false, Rollout::Local)];

        let resolved = resolve_with(&metas, &[("local_flag", true)]);

        assert_eq!(resolved.get("local_flag"), Some(&false));
    }

    /// The kill switch for an already-shipped feature: the code ships it on,
    /// and PostHog at 0% must be able to take it away without a release. If
    /// this ever regresses, disabling a broken feature would require shipping a
    /// new binary, which is the whole reason the remote path exists.
    #[test]
    fn posthogs_false_overrides_a_true_default() {
        let metas = [meta_for_test("remote_flag", true, Rollout::Remote)];

        let resolved = resolve_with(&metas, &[("remote_flag", false)]);

        assert_eq!(resolved.get("remote_flag"), Some(&false));
    }

    #[test]
    fn a_remote_flag_absent_from_posthog_keeps_its_default() {
        let metas = [meta_for_test("remote_flag", true, Rollout::Remote)];

        let resolved = resolve_with(&metas, &[("some_other_flag", false)]);

        assert_eq!(resolved.get("remote_flag"), Some(&true));
    }

    #[test]
    fn posthog_keys_outside_the_registry_are_not_adopted() {
        let metas = [meta_for_test("known_flag", false, Rollout::Remote)];

        let resolved = resolve_with(&metas, &[("stranger_flag", true)]);

        assert!(!resolved.contains_key("stranger_flag"));
    }

    #[test]
    fn mixed_registry_overlays_only_the_remote_half() {
        let metas = [
            meta_for_test("local_flag", false, Rollout::Local),
            meta_for_test("remote_flag", false, Rollout::Remote),
        ];

        let resolved = resolve_with(&metas, &[("local_flag", true), ("remote_flag", true)]);

        assert_eq!(resolved.get("local_flag"), Some(&false));
        assert_eq!(resolved.get("remote_flag"), Some(&true));
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
        out.push_str("<!-- Generated by `cargo test -p analytics`. Do not edit by hand. -->\n");
        out.push_str("<!-- Source of truth: crates/analytics/src/flags.rs -->\n\n");
        out.push_str(
            "| Key | Status | Rollout | Owner | Created | Retire by | Default | Description |\n",
        );
        out.push_str("| --- | --- | --- | --- | --- | --- | --- | --- |\n");
        for meta in registry() {
            out.push_str(&format!(
                "| `{}` | {} | {} | {} | {} | {} | {} | {} |\n",
                meta.key,
                meta.status.as_str(),
                meta.rollout.as_str(),
                meta.owner,
                meta.created,
                meta.retire_by,
                if meta.default_enabled { "on" } else { "off" },
                meta.description,
            ));
        }

        out.push_str("\n## Trying a flag on your own machine\n\n");
        out.push_str(
            "The renderer receives only `key` + resolved value; there is no user-facing \
             force. To exercise a flag whose rollout has not reached you:\n\n",
        );
        out.push_str(
            "- Preferred: add a release condition for yourself in the PostHog dashboard \
             (internal cohort / your distinct id). The client then runs the exact \
             production path.\n",
        );
        out.push_str(
            "- Dev builds only: `chroFlags.force(\"<key>\", true)` in the devtools \
             console (`chroFlags.list()`, `.unforce()`, `.reset()`). Forces persist in \
             localStorage. Release builds compile this out, so the remote kill switch \
             stays authoritative for every shipped binary.\n",
        );

        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/FLAGS.md");
        std::fs::write(path, out).expect("write FLAGS.md");
    }

    /// Regenerates the renderer's view of the registry: the key union and each
    /// flag's compile-time default. The renderer starts from these defaults so
    /// a flag reads its true value before (or without) a registry fetch, which
    /// keeps gated UI from flashing on startup and honours the same
    /// "failure yields defaults" promise `resolve_all` makes. Generated rather
    /// than hand-mirrored so the two languages cannot drift.
    #[test]
    fn generate_flag_keys_ts() {
        let metas = registry();

        let mut out = String::new();
        out.push_str("// Generated by `cargo test -p analytics`. Do not edit by hand.\n");
        out.push_str("// Source of truth: crates/analytics/src/flags.rs\n\n");

        out.push_str("/** Every feature flag key known to the application. */\n");
        if metas.is_empty() {
            out.push_str("export type FlagKey = never;\n\n");
        } else {
            out.push_str("export type FlagKey =\n");
            for meta in &metas {
                out.push_str(&format!("  | \"{}\";\n", meta.key));
            }
            out.push('\n');
        }

        out.push_str("/**\n");
        out.push_str(" * Each flag's default, mirrored from the Rust registry.\n");
        out.push_str(" * The renderer reads these until the resolved registry\n");
        out.push_str(" * arrives, and keeps them if it never does.\n");
        out.push_str(" */\n");
        out.push_str("export const FLAG_DEFAULTS: Record<FlagKey, boolean> = {\n");
        for meta in &metas {
            out.push_str(&format!("  {}: {},\n", meta.key, meta.default_enabled));
        }
        out.push_str("};\n");

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/desktop/src/lib/flags.generated.ts"
        );
        std::fs::write(path, out).expect("write flags.generated.ts");
    }
}
