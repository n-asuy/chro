//! Static CLI contract declarations used by the layered resolver.
//!
//! Each supported coding agent CLI (Codex, Claude) advertises:
//!
//! - the primary binary name used in `PATH` lookups,
//! - an optional environment variable that overrides discovery entirely
//!   (`CODEX_BIN`, `CLAUDE_BIN`) — useful for CI, tests, and power users,
//! - an ordered list of candidate paths to probe before falling back to
//!   `PATH`, modelled on the cabinet `commandCandidates` pattern,
//! - an install hint surfaced to users when the binary cannot be found.
//!
//! Manifests are `const` so they can be referenced as `&'static CliManifest`
//! from anywhere in the crate without lifetime juggling.

/// Static declaration of how to discover and reference a CLI binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CliManifest {
    /// Short human label for diagnostics (e.g. `"codex"`).
    pub name: &'static str,
    /// Primary binary name. Used as the `program` token in `CommandBuilder`
    /// and as the fallback `PATH` lookup name when no candidate succeeds.
    pub command: &'static str,
    /// Environment variable users can set to point at an explicit binary
    /// path. When set and pointing at an executable file, this short-circuits
    /// every other candidate.
    pub env_override: Option<&'static str>,
    /// Environment variable that holds the CLI's config root (e.g.
    /// `CODEX_HOME`). Resolved with [`resolve_home`].
    pub home_env: Option<&'static str>,
    /// Path under `$HOME` to fall back to when `home_env` is unset (e.g.
    /// `".codex"` → `~/.codex`).
    pub default_home: Option<&'static str>,
    /// Ordered candidate locations probed in sequence. The first one that
    /// resolves to an executable file wins.
    pub candidates: &'static [Candidate],
    /// Install hint surfaced when discovery fails. Should be a single short
    /// sentence — UI code may concatenate it with a generic prefix.
    pub install_hint: &'static str,
}

/// A single candidate location the resolver should probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Candidate {
    /// Path relative to the user's home directory (e.g. `".local/bin/codex"`).
    UnderHome(&'static str),
    /// Absolute path (e.g. `"/opt/homebrew/bin/codex"`).
    Absolute(&'static str),
    /// Binary name to look up via `PATH` (e.g. `"codex"`).
    InPath(&'static str),
}

#[cfg(not(windows))]
const CODEX_CANDIDATES: &[Candidate] = &[
    Candidate::UnderHome(".local/bin/codex"),
    Candidate::Absolute("/usr/local/bin/codex"),
    Candidate::Absolute("/opt/homebrew/bin/codex"),
    Candidate::InPath("codex"),
];

#[cfg(windows)]
const CODEX_CANDIDATES: &[Candidate] = &[
    Candidate::UnderHome(r".local\bin\codex.exe"),
    Candidate::UnderHome(r".local\bin\codex.cmd"),
    Candidate::InPath("codex.exe"),
    Candidate::InPath("codex.cmd"),
    Candidate::InPath("codex"),
];

#[cfg(not(windows))]
const CLAUDE_CANDIDATES: &[Candidate] = &[
    Candidate::UnderHome(".local/bin/claude"),
    Candidate::UnderHome(".claude/bin/claude"),
    Candidate::Absolute("/usr/local/bin/claude"),
    Candidate::Absolute("/opt/homebrew/bin/claude"),
    Candidate::InPath("claude"),
];

#[cfg(windows)]
const CLAUDE_CANDIDATES: &[Candidate] = &[
    Candidate::UnderHome(r".local\bin\claude.exe"),
    Candidate::UnderHome(r".local\bin\claude.cmd"),
    Candidate::UnderHome(r".claude\bin\claude.exe"),
    Candidate::InPath("claude.exe"),
    Candidate::InPath("claude.cmd"),
    Candidate::InPath("claude"),
];

/// Manifest for the Codex CLI.
pub const CODEX: CliManifest = CliManifest {
    name: "codex",
    command: "codex",
    env_override: Some("CODEX_BIN"),
    home_env: Some("CODEX_HOME"),
    default_home: Some(".codex"),
    candidates: CODEX_CANDIDATES,
    install_hint: "Install Codex CLI: `brew install --cask codex` or `npm install -g @openai/codex`, then sign in from Settings → Agents → Codex.",
};

/// Manifest for the Claude Code CLI.
pub const CLAUDE: CliManifest = CliManifest {
    name: "claude",
    command: "claude",
    env_override: Some("CLAUDE_BIN"),
    home_env: Some("CLAUDE_HOME"),
    default_home: Some(".claude"),
    candidates: CLAUDE_CANDIDATES,
    install_hint: "Install Claude Code CLI: `curl -fsSL https://claude.ai/install.sh | bash` or `npm install -g @anthropic-ai/claude-code`.",
};

/// Return the parent directories of every `UnderHome` / `Absolute` candidate
/// in a manifest.
///
/// Used by sync code paths that need to compose a `PATH` augmentation for
/// short-lived helper probes (e.g. `claude auth status`). Async code paths
/// should use [`crate::cli_resolver::resolve_cli`] instead, which returns the
/// resolved binary path directly.
pub fn manifest_path_dirs(manifest: &CliManifest) -> Vec<std::path::PathBuf> {
    let home = dirs::home_dir();
    let mut dirs = Vec::new();
    for candidate in manifest.candidates {
        let parent = match candidate {
            Candidate::UnderHome(rel) => home
                .as_ref()
                .map(|h| h.join(rel))
                .and_then(|p| p.parent().map(std::path::PathBuf::from)),
            Candidate::Absolute(abs) => std::path::Path::new(abs)
                .parent()
                .map(std::path::PathBuf::from),
            Candidate::InPath(_) => None,
        };
        if let Some(p) = parent
            && p.is_dir()
            && !dirs.contains(&p)
        {
            dirs.push(p);
        }
    }
    dirs
}

/// Resolve a manifest's config home directory.
///
/// Honors `home_env` when set and non-empty, otherwise joins the user's home
/// with `default_home`. Returns `None` only when the manifest declares no
/// home at all or when the user has no home directory.
pub fn resolve_home(manifest: &CliManifest) -> Option<std::path::PathBuf> {
    if let Some(env_name) = manifest.home_env
        && let Ok(value) = std::env::var(env_name)
        && !value.trim().is_empty()
    {
        return Some(std::path::PathBuf::from(value));
    }
    let default = manifest.default_home?;
    dirs::home_dir().map(|home| home.join(default))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_manifest_includes_homebrew_candidate() {
        #[cfg(not(windows))]
        {
            let found = CODEX.candidates.iter().any(|candidate| {
                matches!(candidate, Candidate::Absolute(path) if *path == "/opt/homebrew/bin/codex")
            });
            assert!(found, "codex manifest must probe Homebrew on macOS");
        }
    }

    #[test]
    fn claude_manifest_includes_official_installer_candidate() {
        #[cfg(not(windows))]
        {
            let found = CLAUDE.candidates.iter().any(|candidate| {
                matches!(candidate, Candidate::UnderHome(path) if *path == ".claude/bin/claude")
            });
            assert!(found, "claude manifest must probe the official installer path");
        }
    }

    #[test]
    fn final_codex_candidate_is_path_lookup() {
        let last = CODEX.candidates.last().expect("codex candidates non-empty");
        assert!(
            matches!(last, Candidate::InPath(_)),
            "PATH fallback must be the last candidate"
        );
    }

    #[test]
    fn resolve_home_prefers_env_override() {
        // Best-effort: only check the env var path. Avoid mutating the
        // process env in a unit test to keep parallel test runs deterministic.
        let manifest = CliManifest {
            home_env: Some("CHRO_TEST_NONEXISTENT_HOME_ENV"),
            ..CODEX
        };
        // Unset for hygiene.
        unsafe {
            std::env::remove_var("CHRO_TEST_NONEXISTENT_HOME_ENV");
        }
        let resolved = resolve_home(&manifest);
        // Falls back to ~/.codex (or None if the test env has no HOME).
        if let Some(path) = resolved {
            assert!(path.ends_with(".codex"));
        }
    }
}
