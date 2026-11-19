use anyhow::{bail, Context, Result};
use std::path::Path;
use tokio::process::Command;

/// No shell expansion, user-supplied remotes or credential helpers.
pub async fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .arg("-c")
        .arg("credential.helper=")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await?;
    if !output.status.success() {
        bail!(
            "git {}: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub async fn repository_bundle(repo: &Path) -> Result<Vec<u8>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("repository.bundle");
    git(
        repo,
        &[
            "bundle",
            "create",
            path.to_str().context("Invalid bundle path")?,
            "HEAD",
        ],
    )
    .await?;
    Ok(tokio::fs::read(path).await?)
}

/// Fetch objects first, then advance only this session's isolated checkout.
/// A fast-forward refusal keeps both the local work and downloaded objects.
pub async fn import_bundle(repo: &Path, bytes: &[u8]) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("result.bundle");
    tokio::fs::write(&path, bytes).await?;
    let path = path.to_str().context("Invalid bundle path")?;
    git(repo, &["bundle", "verify", path]).await?;
    git(repo, &["fetch", "--no-tags", path, "HEAD"]).await?;
    git(repo, &["merge", "--ff-only", "FETCH_HEAD"]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn bundle_round_trip_preserves_origin_and_imports_result() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let remote = root.path().join("remote");
        tokio::fs::create_dir(&source).await.unwrap();
        git(&source, &["init", "-b", "main"]).await.unwrap();
        git(&source, &["config", "user.name", "Test"])
            .await
            .unwrap();
        git(&source, &["config", "user.email", "test@example.test"])
            .await
            .unwrap();
        tokio::fs::write(source.join("file"), "before")
            .await
            .unwrap();
        git(&source, &["add", "."]).await.unwrap();
        git(&source, &["commit", "-m", "base"]).await.unwrap();
        let bundle = root.path().join("input.bundle");
        tokio::fs::write(&bundle, repository_bundle(&source).await.unwrap())
            .await
            .unwrap();
        git(
            root.path(),
            &["clone", bundle.to_str().unwrap(), remote.to_str().unwrap()],
        )
        .await
        .unwrap();
        git(&remote, &["config", "user.name", "Test"])
            .await
            .unwrap();
        git(&remote, &["config", "user.email", "test@example.test"])
            .await
            .unwrap();
        tokio::fs::write(remote.join("file"), "after")
            .await
            .unwrap();
        git(&remote, &["add", "."]).await.unwrap();
        git(&remote, &["commit", "-m", "result"]).await.unwrap();
        import_bundle(&source, &repository_bundle(&remote).await.unwrap())
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(source.join("file"))
                .await
                .unwrap(),
            "after"
        );
        assert!(git(&source, &["remote"]).await.unwrap().is_empty());
    }
}
