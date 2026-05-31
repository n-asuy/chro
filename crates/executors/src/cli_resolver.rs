//! Layered CLI binary resolver driven by [`CliManifest`].
//!
//! The resolver implements a deterministic, diagnostics-rich discovery
//! sequence:
//!
//! 1. **Environment override** — when `manifest.env_override` is set and the
//!    env var points at an executable file, that path wins. This is the
//!    designated escape hatch for tests, CI, and power users running custom
//!    builds.
//! 2. **Candidate list** — each [`Candidate`] is probed in declaration order.
//!    `UnderHome` / `Absolute` candidates are checked with `is_file()`;
//!    `InPath` candidates are looked up via `which`. The first match wins.
//! 3. **Login-shell PATH refresh** — if no candidate matches, the resolver
//!    triggers [`crate::shell::resolve_executable_path`]'s login-shell PATH
//!    refresh (covers desktop apps launched from Finder where the GUI PATH
//!    lacks Homebrew / NVM entries) and re-walks the candidate list.
//!
//! When all stages fail, the resolver returns `None`. Callers should map
//! this to [`crate::executors::ExecutorError::ExecutableNotFound`] with the
//! manifest's `install_hint`.

use std::path::PathBuf;

use crate::cli_manifest::{Candidate, CliManifest};

/// A successfully resolved CLI binary along with how it was found.
#[derive(Debug, Clone)]
pub struct ResolvedBinary {
    pub path: PathBuf,
    pub source: ResolutionSource,
}

/// Which stage of the layered resolver produced the match. Surfaced in
/// logs so operators can quickly tell whether a user is running the
/// Homebrew build, an NVM-shadowed build, or a `*_BIN` override.
#[derive(Debug, Clone)]
pub enum ResolutionSource {
    /// Matched via the manifest's `env_override` variable.
    EnvOverride {
        env_name: &'static str,
    },
    /// Matched a candidate path under the user's home directory.
    UnderHome(&'static str),
    /// Matched an absolute candidate path.
    Absolute(&'static str),
    /// Matched via `PATH` lookup using `which`.
    Path {
        name: &'static str,
    },
}

/// Resolve a CLI binary using the manifest's layered discovery sequence.
pub async fn resolve_cli(manifest: &'static CliManifest) -> Option<ResolvedBinary> {
    if let Some(found) = resolve_from_env(manifest) {
        return Some(found);
    }

    if let Some(found) = walk_candidates(manifest).await {
        return Some(found);
    }

    if crate::shell::refresh_login_shell_path().await
        && let Some(found) = walk_candidates(manifest).await
    {
        return Some(found);
    }

    None
}

fn resolve_from_env(manifest: &CliManifest) -> Option<ResolvedBinary> {
    let env_name = manifest.env_override?;
    let value = std::env::var(env_name).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if !path.is_file() {
        return None;
    }
    Some(ResolvedBinary {
        path,
        source: ResolutionSource::EnvOverride { env_name },
    })
}

async fn walk_candidates(manifest: &'static CliManifest) -> Option<ResolvedBinary> {
    let home = dirs::home_dir();
    for candidate in manifest.candidates {
        match candidate {
            Candidate::UnderHome(rel) => {
                if let Some(h) = home.as_ref() {
                    let path = h.join(rel);
                    if path.is_file() {
                        return Some(ResolvedBinary {
                            path,
                            source: ResolutionSource::UnderHome(rel),
                        });
                    }
                }
            }
            Candidate::Absolute(abs) => {
                let path = PathBuf::from(abs);
                if path.is_file() {
                    return Some(ResolvedBinary {
                        path,
                        source: ResolutionSource::Absolute(abs),
                    });
                }
            }
            Candidate::InPath(name) => {
                if let Some(found) = crate::shell::which_executable(name).await {
                    return Some(ResolvedBinary {
                        path: found,
                        source: ResolutionSource::Path { name },
                    });
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_manifest::CliManifest;

    // We cannot rely on `std::env::set_var` in parallel unit tests, so the
    // env-override path is covered indirectly via integration testing. Here
    // we verify the candidate walker behaves correctly when called with an
    // empty candidate list.
    #[tokio::test]
    async fn empty_candidates_yields_none() {
        let manifest = CliManifest {
            name: "test",
            command: "noop",
            env_override: None,
            home_env: None,
            default_home: None,
            candidates: &[],
            install_hint: "n/a",
        };
        // Leak the manifest so it has 'static lifetime for the resolver.
        let leaked: &'static CliManifest = Box::leak(Box::new(manifest));
        assert!(walk_candidates(leaked).await.is_none());
    }

    #[tokio::test]
    async fn absolute_candidate_resolves_when_present() {
        // `/bin/sh` is present on every supported Unix host.
        #[cfg(not(windows))]
        {
            let manifest = CliManifest {
                name: "sh-probe",
                command: "sh",
                env_override: None,
                home_env: None,
                default_home: None,
                candidates: &[Candidate::Absolute("/bin/sh")],
                install_hint: "n/a",
            };
            let leaked: &'static CliManifest = Box::leak(Box::new(manifest));
            let resolved = walk_candidates(leaked)
                .await
                .expect("sh must resolve on Unix");
            assert_eq!(resolved.path, PathBuf::from("/bin/sh"));
            assert!(matches!(resolved.source, ResolutionSource::Absolute(_)));
        }
    }
}
