//! `chro skill ...`: put the `chro` skill where agent harnesses find it.
//!
//! What `install` writes is an entry point: when to reach for chro, and to
//! run `chro skill show`, which prints the guide built into this binary. The
//! installed file therefore never lists commands and never goes stale when chro
//! updates. It is written once to `~/.agents/skills/chro`, and each harness's
//! skill folder links there, so harnesses never drift apart.
//! Nothing a person made is deleted: a folder in the way is renamed aside, and
//! only with `--force`.

use std::{
    fs, io,
    path::{Path, PathBuf},
    process::ExitCode,
};

use clap::Subcommand;
use serde::Serialize;
use server_contract::{ErrorBody, ErrorCode, Meta};

use super::{
    client::Answer,
    output::{finish, Human, Mode},
};

/// What `install` puts in the harness folders: when to use chro, and to load
/// the guide from the binary.
pub(crate) const SKILL_MD: &str = include_str!("../../../../skills/chro/SKILL.md");
/// The full guide, printed by `chro skill show`. Never installed, so a copy
/// can never outlive the binary it describes.
pub(crate) const GUIDE_MD: &str = include_str!("../../../../skills/chro/guide.md");
const SKILL_NAME: &str = "chro";

#[derive(Subcommand, Debug)]
pub enum SkillCommand {
    /// Install or update the chro skill for every agent harness on this machine
    Install {
        /// Report what would change without writing anything
        #[arg(long)]
        dry_run: bool,
        /// Move a conflicting folder aside instead of skipping it
        #[arg(long)]
        force: bool,
    },
    /// Print the guide to these commands (the installed skill points here)
    Show,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Outcome {
    Installed,
    Updated,
    Unchanged,
    /// Something else owns the location; left alone.
    Conflict,
    /// The harness is not installed on this machine.
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct TargetReport {
    pub harness: String,
    pub path: PathBuf,
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct InstallReport {
    pub skill: PathBuf,
    pub dry_run: bool,
    pub targets: Vec<TargetReport>,
}

impl Human for InstallReport {
    fn human(&self) -> String {
        let mut out = String::new();
        for target in &self.targets {
            let verb = match target.outcome {
                Outcome::Installed => "installed",
                Outcome::Updated => "updated",
                Outcome::Unchanged => "up to date",
                Outcome::Conflict => "conflict",
                Outcome::Skipped => "skipped",
            };
            out.push_str(&format!(
                "{:<8} {:<11} {}",
                target.harness,
                verb,
                target.path.display()
            ));
            if let Some(detail) = &target.detail {
                out.push_str(&format!("  ({detail})"));
            }
            out.push('\n');
        }
        if self.dry_run {
            out.push_str("dry run: nothing was written\n");
        }
        out
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SkillDoc {
    pub markdown: String,
}

impl Human for SkillDoc {
    fn human(&self) -> String {
        self.markdown.clone()
    }
}

/// Where each harness looks for skills, given the user's home and the
/// harnesses' own overrides.
pub(crate) struct Locations {
    pub canonical: PathBuf,
    /// (harness, its skills folder, whether the harness is installed)
    pub harnesses: Vec<(String, PathBuf, bool)>,
}

impl Locations {
    pub fn for_home(home: &Path, claude_config: Option<PathBuf>, codex_home: Option<PathBuf>) -> Self {
        let claude = claude_config.unwrap_or_else(|| home.join(".claude"));
        let codex = codex_home.unwrap_or_else(|| home.join(".codex"));
        Self {
            canonical: home.join(".agents").join("skills").join(SKILL_NAME),
            harnesses: vec![
                ("claude".into(), claude.join("skills"), claude.is_dir()),
                ("codex".into(), codex.join("skills"), codex.is_dir()),
            ],
        }
    }

    fn from_env() -> Result<Self, ErrorBody> {
        let home = dirs::home_dir()
            .ok_or_else(|| ErrorBody::new(ErrorCode::Internal, "no home directory"))?;
        let env_dir = |key: &str| {
            std::env::var_os(key)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        Ok(Self::for_home(
            &home,
            env_dir("CLAUDE_CONFIG_DIR"),
            env_dir("CODEX_HOME"),
        ))
    }
}

/// Whether a skill file at `path` is a chro skill (any version).
fn is_ours(path: &Path) -> bool {
    fs::read_to_string(path).is_ok_and(|text| {
        // The name sits in the frontmatter at the top.
        text.lines()
            .take(20)
            .any(|line| line.trim() == format!("name: {SKILL_NAME}"))
    })
}

fn io_error(path: &Path, err: io::Error) -> ErrorBody {
    ErrorBody::new(ErrorCode::Internal, format!("{}: {err}", path.display()))
}

/// Write the canonical copy.
fn install_canonical(
    dir: &Path,
    content: &str,
    dry_run: bool,
    force: bool,
) -> Result<TargetReport, ErrorBody> {
    let file = dir.join("SKILL.md");
    let report = |outcome, detail: Option<String>| TargetReport {
        harness: "agents".into(),
        path: dir.to_path_buf(),
        outcome,
        detail,
    };
    let outcome = match fs::read_to_string(&file) {
        Ok(existing) if existing == content => return Ok(report(Outcome::Unchanged, None)),
        Ok(_) if !is_ours(&file) && !force => {
            return Ok(report(
                Outcome::Conflict,
                Some("another skill named chro lives here; rerun with --force to move it aside".into()),
            ))
        }
        Ok(_) => Outcome::Updated,
        Err(_) => Outcome::Installed,
    };
    if !dry_run {
        if outcome == Outcome::Updated && !is_ours(&file) {
            move_aside(dir)?;
        }
        fs::create_dir_all(dir).map_err(|err| io_error(dir, err))?;
        fs::write(&file, content).map_err(|err| io_error(&file, err))?;
    }
    Ok(report(outcome, None))
}

/// Point one harness's `skills/chro` at the canonical folder.
fn install_link(
    harness: &str,
    skills_dir: &Path,
    installed: bool,
    canonical: &Path,
    dry_run: bool,
    force: bool,
) -> Result<TargetReport, ErrorBody> {
    let link = skills_dir.join(SKILL_NAME);
    let report = |outcome, detail: Option<String>| TargetReport {
        harness: harness.to_string(),
        path: link.clone(),
        outcome,
        detail,
    };
    if !installed {
        return Ok(report(Outcome::Skipped, Some("harness not found".into())));
    }

    let outcome = match fs::symlink_metadata(&link) {
        Err(_) => Outcome::Installed,
        Ok(meta) if meta.file_type().is_symlink() => match fs::read_link(&link) {
            Ok(target) if target == canonical => return Ok(report(Outcome::Unchanged, None)),
            // A link elsewhere is replaceable when it points at a chro skill
            // (an older install); removing a link deletes nothing it points to.
            _ if is_ours(&link.join("SKILL.md")) || force => Outcome::Updated,
            _ => {
                return Ok(report(
                    Outcome::Conflict,
                    Some("links to a different skill; rerun with --force to replace the link".into()),
                ))
            }
        },
        Ok(_) if force => Outcome::Updated,
        Ok(_) => {
            return Ok(report(
                Outcome::Conflict,
                Some("a folder is in the way; rerun with --force to move it aside".into()),
            ))
        }
    };

    if !dry_run {
        if outcome == Outcome::Updated {
            let meta = fs::symlink_metadata(&link).map_err(|err| io_error(&link, err))?;
            if meta.file_type().is_symlink() {
                remove_link(&link)?;
            } else {
                move_aside(&link)?;
            }
        }
        fs::create_dir_all(skills_dir).map_err(|err| io_error(skills_dir, err))?;
        make_link(canonical, &link)?;
    }
    Ok(report(outcome, None))
}

/// Rename `path` to `path.bak-<timestamp>` so nothing is lost.
fn move_aside(path: &Path) -> Result<(), ErrorBody> {
    let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
    let aside = path.with_file_name(format!(
        "{}.bak-{stamp}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or(SKILL_NAME)
    ));
    fs::rename(path, &aside).map_err(|err| io_error(path, err))
}

#[cfg(unix)]
fn make_link(target: &Path, link: &Path) -> Result<(), ErrorBody> {
    std::os::unix::fs::symlink(target, link).map_err(|err| io_error(link, err))
}

#[cfg(windows)]
fn make_link(target: &Path, link: &Path) -> Result<(), ErrorBody> {
    // Directory symlinks need a privilege most Windows users lack; a junction
    // does not and behaves the same for readers.
    std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()
        .map_err(|err| io_error(link, err))
        .and_then(|status| {
            status
                .success()
                .then_some(())
                .ok_or_else(|| ErrorBody::new(ErrorCode::Internal, format!("mklink /J {} failed", link.display())))
        })
}

#[cfg(unix)]
fn remove_link(link: &Path) -> Result<(), ErrorBody> {
    fs::remove_file(link).map_err(|err| io_error(link, err))
}

#[cfg(windows)]
fn remove_link(link: &Path) -> Result<(), ErrorBody> {
    fs::remove_dir(link).map_err(|err| io_error(link, err))
}

pub(crate) fn install(
    locations: &Locations,
    content: &str,
    dry_run: bool,
    force: bool,
) -> Result<InstallReport, ErrorBody> {
    let mut targets = vec![install_canonical(
        &locations.canonical,
        content,
        dry_run,
        force,
    )?];
    for (harness, dir, installed) in &locations.harnesses {
        targets.push(install_link(
            harness,
            dir,
            *installed,
            &locations.canonical,
            dry_run,
            force,
        )?);
    }
    Ok(InstallReport {
        skill: locations.canonical.clone(),
        dry_run,
        targets,
    })
}

fn local<T>(result: T) -> Answer<T> {
    Answer {
        result,
        meta: Meta::local(),
    }
}

pub(crate) fn run(command: SkillCommand, mode: Mode) -> ExitCode {
    match command {
        SkillCommand::Install { dry_run, force } => finish(
            mode,
            Locations::from_env()
                .and_then(|locations| install(&locations, SKILL_MD, dry_run, force))
                .map(local),
        ),
        SkillCommand::Show => finish(
            mode,
            Ok::<_, ErrorBody>(local(SkillDoc {
                markdown: GUIDE_MD.to_string(),
            })),
        ),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    const V1: &str = "---\nname: chro\n---\nv1\n";
    const V2: &str = "---\nname: chro\n---\nv2\n";

    fn setup() -> (tempfile::TempDir, Locations) {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        let locations = Locations::for_home(home.path(), None, None);
        (home, locations)
    }

    fn outcomes(report: &InstallReport) -> Vec<(String, Outcome)> {
        report
            .targets
            .iter()
            .map(|t| (t.harness.clone(), t.outcome))
            .collect()
    }

    #[test]
    fn installs_once_and_links_only_harnesses_that_exist() {
        let (_home, locations) = setup();
        let report = install(&locations, V1, false, false).unwrap();
        assert_eq!(
            outcomes(&report),
            vec![
                ("agents".into(), Outcome::Installed),
                ("claude".into(), Outcome::Installed),
                ("codex".into(), Outcome::Skipped),
            ]
        );
        let link = locations.harnesses[0].1.join("chro");
        assert_eq!(fs::read_link(&link).unwrap(), locations.canonical);
        assert_eq!(fs::read_to_string(link.join("SKILL.md")).unwrap(), V1);
    }

    #[test]
    fn reinstalling_is_a_no_op_and_a_new_version_updates_in_place() {
        let (_home, locations) = setup();
        install(&locations, V1, false, false).unwrap();
        let again = install(&locations, V1, false, false).unwrap();
        assert_eq!(again.targets[0].outcome, Outcome::Unchanged);
        assert_eq!(again.targets[1].outcome, Outcome::Unchanged);

        let updated = install(&locations, V2, false, false).unwrap();
        assert_eq!(updated.targets[0].outcome, Outcome::Updated);
        assert_eq!(
            fs::read_to_string(locations.canonical.join("SKILL.md")).unwrap(),
            V2
        );
    }

    #[test]
    fn a_folder_in_the_way_is_kept_unless_forced_and_then_moved_aside() {
        let (_home, locations) = setup();
        let squatter = locations.harnesses[0].1.join("chro");
        fs::create_dir_all(&squatter).unwrap();
        fs::write(squatter.join("SKILL.md"), "---\nname: other\n---\n").unwrap();

        let report = install(&locations, V1, false, false).unwrap();
        assert_eq!(report.targets[1].outcome, Outcome::Conflict);
        assert!(!fs::symlink_metadata(&squatter).unwrap().file_type().is_symlink());

        let forced = install(&locations, V1, false, true).unwrap();
        assert_eq!(forced.targets[1].outcome, Outcome::Updated);
        assert!(fs::symlink_metadata(&squatter).unwrap().file_type().is_symlink());
        let kept = fs::read_dir(&locations.harnesses[0].1)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("chro.bak-"));
        assert!(kept, "the folder that was in the way must survive");
    }

    #[test]
    fn a_dry_run_writes_nothing() {
        let (_home, locations) = setup();
        let report = install(&locations, V1, true, false).unwrap();
        assert_eq!(report.targets[0].outcome, Outcome::Installed);
        assert!(!locations.canonical.exists());
    }

    #[test]
    fn the_shipped_skill_names_itself_chro() {
        assert!(SKILL_MD.lines().any(|line| line.trim() == "name: chro"));
    }
}

#[cfg(test)]
mod skill_text_tests {
    use clap::Parser;

    use super::{GUIDE_MD, SKILL_MD};
    use crate::args::TerminalCli;

    /// Split a shell line into words, honoring double quotes.
    fn words(line: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut current = String::new();
        let mut quoted = false;
        let mut started = false;
        for c in line.chars() {
            match c {
                '"' => {
                    quoted = !quoted;
                    started = true;
                }
                c if c.is_whitespace() && !quoted => {
                    if started {
                        out.push(std::mem::take(&mut current));
                        started = false;
                    }
                }
                c => {
                    current.push(c);
                    started = true;
                }
            }
        }
        if started {
            out.push(current);
        }
        out
    }

    /// Every `chro ...` line in the code blocks of `markdown`, without shell
    /// redirections.
    fn commands_in(markdown: &str) -> Vec<Vec<String>> {
        let mut in_block = false;
        let mut out = Vec::new();
        for line in markdown.lines() {
            if line.trim_start().starts_with("```") {
                in_block = !in_block;
                continue;
            }
            if in_block && line.trim_start().starts_with("chro ") {
                let mut args = words(line.trim());
                if let Some(redirect) = args.iter().position(|w| w == "<" || w == ">") {
                    args.truncate(redirect);
                }
                out.push(args);
            }
        }
        out
    }

    fn commands() -> Vec<Vec<String>> {
        commands_in(GUIDE_MD)
    }

    #[test]
    fn the_installed_skill_only_points_at_the_guide_this_binary_prints() {
        // What sits in the harness folders never lists commands: a copy left
        // behind by an older or newer chro must not teach the wrong ones.
        let commands = commands_in(SKILL_MD);
        assert_eq!(commands, vec![vec!["chro", "skill", "show"]]);
    }

    #[test]
    fn every_command_the_skill_shows_parses() {
        let commands = commands();
        assert!(commands.len() > 15, "expected the skill to show its commands");
        for args in commands {
            if let Err(err) = TerminalCli::try_parse_from(&args) {
                panic!("`{}` does not parse:\n{err}", args.join(" "));
            }
        }
    }

    #[test]
    fn the_word_splitter_keeps_quoted_text_together() {
        assert_eq!(
            words(r#"chro session send ab --prompt "a b""#),
            vec!["chro", "session", "send", "ab", "--prompt", "a b"]
        );
        assert_eq!(words(r#"--answer "Q?=x""#), vec!["--answer", "Q?=x"]);
    }
}
