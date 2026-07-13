use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

const SKILL_FILE_NAME: &str = "SKILL.md";
const MAX_SELECTED_SKILLS: usize = 8;
const MAX_SKILL_BODY_BYTES: usize = 64 * 1024;
const MAX_MATERIALIZED_BYTES: usize = 192 * 1024;

#[derive(Debug, Error)]
pub enum SkillError {
    #[error("workspace path must be absolute")]
    WorkspacePathNotAbsolute,
    #[error("workspace path does not exist")]
    WorkspacePathMissing,
    #[error("workspace path must point to a directory")]
    WorkspacePathNotDirectory,
    #[error("too many selected skills; maximum is {max}")]
    TooManySelectedSkills { max: usize },
    #[error("selected skill not found: {0}")]
    SkillNotFound(String),
    #[error("materialized skills are too large; maximum is {max_bytes} bytes")]
    MaterializedTooLarge { max_bytes: usize },
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    WorkspaceClaude,
    WorkspaceAgents,
    WorkspaceChro,
    UserClaude,
    UserAgents,
    UserCodex,
}

impl SkillSource {
    fn label(self) -> &'static str {
        match self {
            Self::WorkspaceClaude => "workspace:.claude/skills",
            Self::WorkspaceAgents => "workspace:.agents/skills",
            Self::WorkspaceChro => "workspace:skills",
            Self::UserClaude => "user:.claude/skills",
            Self::UserAgents => "user:.agents/skills",
            Self::UserCodex => "user:.codex/skills",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: SkillSource,
    pub source_label: String,
    pub source_path: String,
    pub base_dir: String,
    /// Absolute path to the skill package directory. Display paths above are
    /// relative for readability; this lets the UI open the folder on disk.
    pub abs_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub summary: SkillSummary,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedSkills {
    pub prompt_block: String,
    pub skills: Vec<SkillSummary>,
    pub byte_size: usize,
}

#[derive(Debug, Clone, Default)]
pub struct SkillRegistry {
    home_dir: Option<PathBuf>,
    /// Codex CLI config root. Honors `$CODEX_HOME`, otherwise `~/.codex`.
    /// Kept separate from `home_dir` because Codex lets users relocate it.
    codex_home: Option<PathBuf>,
}

impl SkillRegistry {
    pub fn new() -> Self {
        let home_dir = dirs::home_dir();
        let codex_home =
            resolve_codex_home(home_dir.as_deref(), std::env::var("CODEX_HOME").ok().as_deref());
        Self {
            home_dir,
            codex_home,
        }
    }

    pub fn with_home_dir(home_dir: Option<PathBuf>) -> Self {
        // Derive the Codex root from the injected home and ignore the ambient
        // `$CODEX_HOME` so tests stay hermetic regardless of the dev/CI env.
        let codex_home = resolve_codex_home(home_dir.as_deref(), None);
        Self {
            home_dir,
            codex_home,
        }
    }

    pub fn list(&self, workspace_path: Option<&Path>) -> Result<Vec<SkillSummary>, SkillError> {
        Ok(self
            .discover(workspace_path)?
            .into_iter()
            .map(|skill| skill.summary)
            .collect())
    }

    pub fn materialize(
        &self,
        workspace_path: Option<&Path>,
        selected_ids: &[String],
    ) -> Result<Option<MaterializedSkills>, SkillError> {
        let selected_ids = normalize_selected_ids(selected_ids);
        if selected_ids.is_empty() {
            return Ok(None);
        }
        if selected_ids.len() > MAX_SELECTED_SKILLS {
            return Err(SkillError::TooManySelectedSkills {
                max: MAX_SELECTED_SKILLS,
            });
        }

        let skills_by_id: HashMap<String, Skill> = self
            .discover(workspace_path)?
            .into_iter()
            .map(|skill| (skill.summary.id.clone(), skill))
            .collect();

        let mut selected = Vec::with_capacity(selected_ids.len());
        for id in selected_ids {
            let skill = skills_by_id
                .get(&id)
                .cloned()
                .ok_or_else(|| SkillError::SkillNotFound(id.clone()))?;
            selected.push(skill);
        }

        let mut block = String::from("<skills>\n");
        let mut summaries = Vec::with_capacity(selected.len());
        for skill in selected {
            summaries.push(skill.summary.clone());
            block.push_str(&format!(
                "<skill id=\"{}\" name=\"{}\" source=\"{}\">\n",
                escape_xml_attr(&skill.summary.id),
                escape_xml_attr(&skill.summary.name),
                escape_xml_attr(&skill.summary.source_label),
            ));
            block.push_str(&format!("Base directory: {}\n", skill.summary.base_dir));
            block.push_str("Instructions:\n");
            block.push_str(&truncate_on_boundary(&skill.body, MAX_SKILL_BODY_BYTES));
            if !block.ends_with('\n') {
                block.push('\n');
            }
            block.push_str("</skill>\n");
            if block.len() > MAX_MATERIALIZED_BYTES {
                return Err(SkillError::MaterializedTooLarge {
                    max_bytes: MAX_MATERIALIZED_BYTES,
                });
            }
        }
        block.push_str("</skills>\n");

        let byte_size = block.len();
        Ok(Some(MaterializedSkills {
            prompt_block: block,
            skills: summaries,
            byte_size,
        }))
    }

    fn discover(&self, workspace_path: Option<&Path>) -> Result<Vec<Skill>, SkillError> {
        if let Some(path) = workspace_path {
            validate_workspace_path(path)?;
        }

        let mut roots = Vec::new();
        if let Some(workspace) = workspace_path {
            roots.push((
                SkillSource::WorkspaceClaude,
                workspace.join(".claude").join("skills"),
                Some(workspace.to_path_buf()),
            ));
            roots.push((
                SkillSource::WorkspaceAgents,
                workspace.join(".agents").join("skills"),
                Some(workspace.to_path_buf()),
            ));
            roots.push((
                SkillSource::WorkspaceChro,
                workspace.join("skills"),
                Some(workspace.to_path_buf()),
            ));
        }

        if let Some(home) = &self.home_dir {
            roots.push((
                SkillSource::UserClaude,
                home.join(".claude").join("skills"),
                Some(home.clone()),
            ));
            roots.push((
                SkillSource::UserAgents,
                home.join(".agents").join("skills"),
                Some(home.clone()),
            ));
        }

        if let Some(codex_home) = &self.codex_home {
            // Display paths relative to home so a default `~/.codex` reads as
            // `.codex/skills/...`; a relocated `$CODEX_HOME` outside home falls
            // back to its absolute path, which is still informative.
            roots.push((
                SkillSource::UserCodex,
                codex_home.join("skills"),
                self.home_dir.clone(),
            ));
        }

        let mut skills = Vec::new();
        let mut seen = HashSet::new();
        for (source, root, display_base) in roots {
            for skill_file in find_skill_files(&root)? {
                let skill = parse_skill_file(source, &skill_file, &root, display_base.as_deref())?;
                if seen.insert(skill.summary.id.clone()) {
                    skills.push(skill);
                }
            }
        }

        skills.sort_by(|a, b| {
            source_rank(a.summary.source)
                .cmp(&source_rank(b.summary.source))
                .then_with(|| a.summary.name.cmp(&b.summary.name))
                .then_with(|| a.summary.id.cmp(&b.summary.id))
        });

        Ok(skills)
    }
}

pub fn apply_materialized_skills(
    prompt: &str,
    materialized: Option<&MaterializedSkills>,
) -> String {
    match materialized {
        Some(skills) if !skills.prompt_block.trim().is_empty() => {
            format!(
                "{}\n{}",
                skills.prompt_block.trim_end(),
                prompt.trim_start()
            )
        }
        _ => prompt.to_string(),
    }
}

/// Resolve the Codex CLI config root, mirroring the Codex convention used
/// elsewhere in the workspace (`executors::cli_manifest::resolve_home`):
/// honor `$CODEX_HOME` when set and non-empty, otherwise fall back to
/// `<home>/.codex`. The env value is passed in (rather than read here) so the
/// resolution stays a pure, hermetically testable function.
fn resolve_codex_home(home: Option<&Path>, codex_home_env: Option<&str>) -> Option<PathBuf> {
    if let Some(value) = codex_home_env {
        if !value.trim().is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    home.map(|home| home.join(".codex"))
}

fn validate_workspace_path(path: &Path) -> Result<(), SkillError> {
    if !path.is_absolute() {
        return Err(SkillError::WorkspacePathNotAbsolute);
    }
    let metadata = fs::metadata(path).map_err(|_| SkillError::WorkspacePathMissing)?;
    if !metadata.is_dir() {
        return Err(SkillError::WorkspacePathNotDirectory);
    }
    Ok(())
}

fn find_skill_files(root: &Path) -> Result<Vec<PathBuf>, SkillError> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name == SKILL_FILE_NAME)
            {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

fn parse_skill_file(
    source: SkillSource,
    skill_file: &Path,
    id_base: &Path,
    display_base: Option<&Path>,
) -> Result<Skill, SkillError> {
    let raw = fs::read_to_string(skill_file)?;
    let (metadata, body) = split_frontmatter(&raw);
    let base_dir = skill_file.parent().unwrap_or(skill_file);
    let fallback_name = base_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill")
        .to_string();
    let name = metadata
        .get("name")
        .cloned()
        .or_else(|| first_heading(body))
        .unwrap_or(fallback_name);
    let description = metadata
        .get("description")
        .cloned()
        .or_else(|| first_paragraph(body))
        .unwrap_or_default();
    let relative_id_path = base_dir
        .strip_prefix(id_base)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .unwrap_or(base_dir);
    let id = format!("{}:{}", source.label(), normalize_path(relative_id_path));
    let source_path = normalize_display_path(skill_file, display_base);
    let base_dir_display = normalize_display_path(base_dir, display_base);
    let source_label = source.label().to_string();
    let abs_dir = base_dir.to_string_lossy().to_string();

    Ok(Skill {
        summary: SkillSummary {
            id,
            name: name.trim().to_string(),
            description: description.trim().to_string(),
            source,
            source_label,
            source_path,
            base_dir: base_dir_display,
            abs_dir,
        },
        body: body.trim().to_string(),
    })
}

fn split_frontmatter(raw: &str) -> (HashMap<String, String>, &str) {
    let mut metadata = HashMap::new();
    if !raw.starts_with("---\n") {
        return (metadata, raw);
    }

    let rest = &raw[4..];
    let Some(end) = rest.find("\n---") else {
        return (metadata, raw);
    };
    let frontmatter = &rest[..end];
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        metadata.insert(key.to_string(), value.to_string());
    }

    let body_start = 4 + end + "\n---".len();
    let body = raw[body_start..].trim_start_matches(['\r', '\n']);
    (metadata, body)
}

fn first_heading(body: &str) -> Option<String> {
    body.lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

fn first_paragraph(body: &str) -> Option<String> {
    let mut paragraph = String::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if trimmed.starts_with('#') || trimmed.starts_with("---") {
            continue;
        }
        if !paragraph.is_empty() {
            paragraph.push(' ');
        }
        paragraph.push_str(trimmed);
        if paragraph.len() >= 180 {
            break;
        }
    }
    if paragraph.is_empty() {
        None
    } else {
        Some(truncate_on_boundary(&paragraph, 180))
    }
}

fn normalize_selected_ids(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for id in ids {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            normalized.push(trimmed.to_string());
        }
    }
    normalized
}

fn normalize_display_path(path: &Path, base: Option<&Path>) -> String {
    if let Some(base) = base {
        if let Ok(relative) = path.strip_prefix(base) {
            return normalize_path(relative);
        }
    }
    normalize_path(path)
}

fn normalize_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn truncate_on_boundary(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated]", &value[..end])
}

fn escape_xml_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn source_rank(source: SkillSource) -> usize {
    match source {
        SkillSource::WorkspaceClaude => 0,
        SkillSource::WorkspaceAgents => 1,
        SkillSource::WorkspaceChro => 2,
        SkillSource::UserClaude => 3,
        SkillSource::UserAgents => 4,
        SkillSource::UserCodex => 5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_skill(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel).join(SKILL_FILE_NAME);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn discovers_workspace_and_user_skills() {
        let workspace = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        write_skill(
            workspace.path(),
            ".claude/skills/release",
            "---\nname: release-train\ndescription: Release work\n---\n# Body\nDo release work.",
        );
        write_skill(
            home.path(),
            ".agents/skills/docs",
            "# Docs\nWrite documentation well.",
        );

        let registry = SkillRegistry::with_home_dir(Some(home.path().to_path_buf()));
        let skills = registry.list(Some(workspace.path())).unwrap();

        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].name, "release-train");
        assert_eq!(skills[0].description, "Release work");
        assert!(skills[0].id.contains("workspace:.claude/skills"));
        assert_eq!(skills[1].name, "Docs");
        assert!(skills[1].id.contains("user:.agents/skills"));
    }

    #[test]
    fn exposes_absolute_package_directory() {
        let workspace = TempDir::new().unwrap();
        write_skill(
            workspace.path(),
            ".claude/skills/release",
            "---\nname: release\ndescription: Release work\n---\n# Body\nDo release work.",
        );

        let registry = SkillRegistry::with_home_dir(None);
        let skills = registry.list(Some(workspace.path())).unwrap();

        let release = skills.iter().find(|skill| skill.name == "release").unwrap();
        let expected = workspace.path().join(".claude/skills/release");
        assert_eq!(release.abs_dir, expected.to_string_lossy());
        // Display path stays relative for readability.
        assert_eq!(release.base_dir, ".claude/skills/release");
    }

    #[test]
    fn discovers_codex_user_skills() {
        let home = TempDir::new().unwrap();
        write_skill(
            home.path(),
            ".codex/skills/reviewer",
            "---\nname: codex-reviewer\ndescription: Review with Codex\n---\n# Body\nReview.",
        );

        let registry = SkillRegistry::with_home_dir(Some(home.path().to_path_buf()));
        let skills = registry.list(None).unwrap();

        let codex = skills
            .iter()
            .find(|skill| skill.id.contains("user:.codex/skills"))
            .expect("codex skill discovered under ~/.codex/skills");
        assert_eq!(codex.name, "codex-reviewer");
        assert_eq!(codex.description, "Review with Codex");
        assert_eq!(codex.base_dir, ".codex/skills/reviewer");
    }

    #[test]
    fn materializes_selected_skills_in_requested_order() {
        let workspace = TempDir::new().unwrap();
        write_skill(workspace.path(), ".claude/skills/a", "# A\nFirst skill.");
        write_skill(workspace.path(), ".claude/skills/b", "# B\nSecond skill.");

        let registry = SkillRegistry::with_home_dir(None);
        let skills = registry.list(Some(workspace.path())).unwrap();
        let b = skills.iter().find(|skill| skill.name == "B").unwrap();
        let a = skills.iter().find(|skill| skill.name == "A").unwrap();
        let materialized = registry
            .materialize(Some(workspace.path()), &[b.id.clone(), a.id.clone()])
            .unwrap()
            .unwrap();

        assert!(
            materialized.prompt_block.find("name=\"B\"").unwrap()
                < materialized.prompt_block.find("name=\"A\"").unwrap()
        );
        let prompt = apply_materialized_skills("Do it", Some(&materialized));
        assert!(prompt.starts_with("<skills>"));
        assert!(prompt.ends_with("Do it"));
    }

    #[test]
    fn resolve_codex_home_honors_env_then_falls_back() {
        let home = Path::new("/home/dev");

        assert_eq!(
            resolve_codex_home(Some(home), Some("/custom/codex")),
            Some(PathBuf::from("/custom/codex")),
            "non-empty CODEX_HOME wins"
        );
        assert_eq!(
            resolve_codex_home(Some(home), Some("   ")),
            Some(home.join(".codex")),
            "blank CODEX_HOME falls back to ~/.codex"
        );
        assert_eq!(
            resolve_codex_home(Some(home), None),
            Some(home.join(".codex")),
            "unset CODEX_HOME falls back to ~/.codex"
        );
        assert_eq!(
            resolve_codex_home(None, None),
            None,
            "no home and no env yields no Codex root"
        );
    }

    #[test]
    fn discovers_skills_under_relocated_codex_home() {
        let codex = TempDir::new().unwrap();
        write_skill(codex.path(), "skills/auditor", "# Auditor\nAudit the change.");

        // Simulate `$CODEX_HOME` pointing outside the user's home directory.
        let registry = SkillRegistry {
            home_dir: None,
            codex_home: Some(codex.path().to_path_buf()),
        };
        let skills = registry.list(None).unwrap();

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].source, SkillSource::UserCodex);
        assert_eq!(skills[0].name, "Auditor");
        assert!(skills[0].id.contains("user:.codex/skills"));
    }

    #[test]
    fn rejects_missing_skill_ids() {
        let workspace = TempDir::new().unwrap();
        let registry = SkillRegistry::with_home_dir(None);
        let err = registry
            .materialize(Some(workspace.path()), &["missing".to_string()])
            .unwrap_err();
        assert!(matches!(err, SkillError::SkillNotFound(_)));
    }
}
