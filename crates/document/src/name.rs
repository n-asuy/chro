//! The name a document is shown under.
//!
//! chro renders some formats as documents rather than as files: a note, a
//! drawing, a table view. For those the extension is an implementation detail
//! — the user named the thing "Design", not "Design.md" — so it is hidden.
//! Every other file keeps its full name, because there the extension is
//! information (`main.rs` and `main.ts` are different files, and `main` names
//! neither).
//!
//! This is deliberately not "strip the last extension from everything": that
//! rule turns `main.rs` into `main` and makes two unrelated files collide in
//! any list that shows display names.

/// Extensions chro renders as documents, whose extension is therefore hidden.
/// Compared case-insensitively.
pub const DOCUMENT_EXTENSIONS: [&str; 4] = ["md", "markdown", "excalidraw", "cbase"];

/// The display name for a file: its name without the extension when chro
/// renders that format as a document, and unchanged otherwise.
///
/// Accepts a bare file name or a path; only the final component is used.
pub fn display_name(name_or_path: &str) -> String {
    let name = file_name_of(name_or_path);
    match name.rfind('.') {
        // A leading dot is not an extension separator: `.gitignore` is a name.
        Some(index) if index > 0 && is_document_extension(&name[index + 1..]) => {
            name[..index].to_string()
        }
        _ => name.to_string(),
    }
}

/// The display name for a directory, which never hides anything. Present so
/// callers that handle both kinds do not have to special-case directories
/// with a bare `to_string`, and so the asymmetry is stated once here.
pub fn directory_display_name(name_or_path: &str) -> String {
    file_name_of(name_or_path).to_string()
}

/// Whether chro renders files with this extension as documents.
pub fn is_document_extension(extension: &str) -> bool {
    DOCUMENT_EXTENSIONS
        .iter()
        .any(|known| known.eq_ignore_ascii_case(extension))
}

fn file_name_of(name_or_path: &str) -> &str {
    name_or_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name_or_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_the_extension_of_rendered_document_formats() {
        assert_eq!(display_name("Design.md"), "Design");
        assert_eq!(display_name("notes.markdown"), "notes");
        assert_eq!(display_name("sketch.excalidraw"), "sketch");
        assert_eq!(display_name("tasks.cbase"), "tasks");
        // Case-insensitive, matching the filesystems chro runs on.
        assert_eq!(display_name("README.MD"), "README");
    }

    #[test]
    fn keeps_the_extension_of_every_other_file() {
        // The rule that strips any extension would collide these two.
        assert_eq!(display_name("main.rs"), "main.rs");
        assert_eq!(display_name("main.ts"), "main.ts");
        assert_eq!(display_name("archive.tar.gz"), "archive.tar.gz");
    }

    #[test]
    fn treats_a_leading_dot_as_part_of_the_name() {
        assert_eq!(display_name(".gitignore"), ".gitignore");
        assert_eq!(display_name(".md"), ".md");
    }

    #[test]
    fn uses_only_the_final_path_component() {
        assert_eq!(display_name("docs/guides/Design.md"), "Design");
        assert_eq!(display_name("docs\\guides\\Design.md"), "Design");
        assert_eq!(directory_display_name("docs/guides"), "guides");
    }

    #[test]
    fn directories_never_hide_anything() {
        // A directory may legitimately be named like a document.
        assert_eq!(directory_display_name("release.md"), "release.md");
    }
}
