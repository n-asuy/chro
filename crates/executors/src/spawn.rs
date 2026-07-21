//! Platform-aware command invocation.
//!
//! A resolved CLI path is not always directly spawnable. On Windows,
//! `CreateProcessW` (which backs `std::process::Command`) can launch `.exe`
//! images but **not** batch shims (`.cmd` / `.bat`). npm-installed global CLIs
//! ship as `.cmd` shims, so a path the resolver correctly reports as "found"
//! fails to execute when spawned directly. Interactive terminals hide this
//! because the shell interprets the shim; a GUI app spawning it directly does
//! not.
//!
//! [`prepare_invocation`] normalizes a `(program, args)` pair for the host
//! platform. On non-Windows hosts, and for native `.exe` targets, it is the
//! identity. For a Windows batch shim it re-targets the invocation through the
//! command interpreter (`%ComSpec% /d /c <shim> <args...>`), passing the shim
//! and its arguments as separate argv entries so the standard library applies
//! its usual Windows argument quoting.
//!
//! Arguments carrying cmd.exe metacharacters (`& | < > ^ " % !`, CR, LF) are
//! **rejected**, not escaped: once the interpreter re-parses the reconstructed
//! command line, argument-level quoting alone cannot neutralize them safely.
//! Callers keep free-form text (prompts, diffs) out of argv — Claude receives
//! its prompt over stdin — so this rejection does not fire in practice and acts
//! as a guard rather than a limitation.

#[cfg(any(windows, test))]
use std::path::Path;
use std::path::PathBuf;

use crate::executors::ExecutorError;

/// A command invocation already adjusted for the host platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Adjust a resolved `(program, args)` pair so it can be spawned on the host.
///
/// Identity on non-Windows hosts and for native Windows executables. Windows
/// batch shims (`.cmd` / `.bat`) are routed through the command interpreter.
pub fn prepare_invocation(
    program: PathBuf,
    args: Vec<String>,
) -> Result<Invocation, ExecutorError> {
    #[cfg(windows)]
    {
        if is_windows_batch_script(&program) {
            return wrap_for_cmd(&program, args, resolve_comspec());
        }
    }

    Ok(Invocation { program, args })
}

/// Whether `program` is a Windows batch shim that cannot be executed directly
/// via `CreateProcessW`. Classifies purely by extension so it is testable on
/// every host. Only reachable at runtime on Windows; compiled under `test`
/// everywhere so the cross-platform unit tests can exercise it.
#[cfg(any(windows, test))]
fn is_windows_batch_script(program: &Path) -> bool {
    program
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// cmd.exe metacharacters that argument quoting cannot safely neutralize once
/// the interpreter re-parses the command line.
#[cfg(any(windows, test))]
fn contains_unsafe_cmd_char(value: &str) -> bool {
    value.chars().any(|c| {
        matches!(
            c,
            '&' | '|' | '<' | '>' | '^' | '"' | '%' | '!' | '\r' | '\n'
        )
    })
}

/// Re-target a batch-shim invocation through the command interpreter.
///
/// Returns `%ComSpec% /d /c <program> <args...>` with the shim and its
/// arguments as separate argv entries. `/d` disables AutoRun commands. Rejects
/// any token carrying a cmd.exe metacharacter.
#[cfg(any(windows, test))]
fn wrap_for_cmd(
    program: &Path,
    args: Vec<String>,
    comspec: PathBuf,
) -> Result<Invocation, ExecutorError> {
    let program_str = program.to_string_lossy();
    if contains_unsafe_cmd_char(&program_str) {
        return Err(ExecutorError::UnsafeWindowsBatchArguments(
            program_str.into_owned(),
        ));
    }
    for arg in &args {
        if contains_unsafe_cmd_char(arg) {
            return Err(ExecutorError::UnsafeWindowsBatchArguments(arg.clone()));
        }
    }

    let mut wrapped = Vec::with_capacity(args.len() + 4);
    wrapped.push("/d".to_string());
    wrapped.push("/c".to_string());
    wrapped.push(program_str.into_owned());
    wrapped.extend(args);

    Ok(Invocation {
        program: comspec,
        args: wrapped,
    })
}

/// Locate the command interpreter from the process environment.
#[cfg(windows)]
fn resolve_comspec() -> PathBuf {
    comspec_from(std::env::var_os("ComSpec"), std::env::var_os("SystemRoot"))
}

/// Pure core of [`resolve_comspec`]: honor `ComSpec`, else derive
/// `<SystemRoot>\System32\cmd.exe`, falling back to `C:\Windows` when
/// `SystemRoot` is absent. Environment values are injected so this is testable
/// on every host.
#[cfg(any(windows, test))]
fn comspec_from(
    comspec: Option<std::ffi::OsString>,
    system_root: Option<std::ffi::OsString>,
) -> PathBuf {
    if let Some(comspec) = comspec {
        return PathBuf::from(comspec);
    }
    // Build with an explicit backslash rather than `Path::join`, whose
    // separator is host-dependent; this path is only ever spawned on Windows.
    let mut system_root = system_root.unwrap_or_else(|| std::ffi::OsString::from(r"C:\Windows"));
    system_root.push(r"\System32\cmd.exe");
    PathBuf::from(system_root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comspec() -> PathBuf {
        PathBuf::from(r"C:\Windows\System32\cmd.exe")
    }

    #[test]
    fn detects_batch_shims_case_insensitively() {
        assert!(is_windows_batch_script(Path::new(r"C:\npm\claude.cmd")));
        assert!(is_windows_batch_script(Path::new(r"C:\npm\CLAUDE.CMD")));
        assert!(is_windows_batch_script(Path::new(r"C:\npm\claude.bat")));
    }

    #[test]
    fn native_executables_are_not_batch_shims() {
        assert!(!is_windows_batch_script(Path::new(
            r"C:\anthropic\claude.exe"
        )));
        assert!(!is_windows_batch_script(Path::new("/usr/local/bin/claude")));
        assert!(!is_windows_batch_script(Path::new("claude")));
    }

    #[test]
    fn wraps_batch_shim_through_interpreter() {
        let invocation = wrap_for_cmd(
            Path::new(r"C:\npm\claude.cmd"),
            vec!["--version".to_string()],
            comspec(),
        )
        .expect("safe args wrap");

        assert_eq!(invocation.program, comspec());
        assert_eq!(
            invocation.args,
            vec![
                "/d".to_string(),
                "/c".to_string(),
                r"C:\npm\claude.cmd".to_string(),
                "--version".to_string(),
            ]
        );
    }

    #[test]
    fn preserves_argument_order_and_spaces() {
        let invocation = wrap_for_cmd(
            Path::new(r"C:\npm\claude.cmd"),
            vec![
                "--settings".to_string(),
                r"C:\Users\Ada Lovelace\settings.json".to_string(),
            ],
            comspec(),
        )
        .expect("path with spaces is safe");

        assert_eq!(
            invocation.args,
            vec![
                "/d".to_string(),
                "/c".to_string(),
                r"C:\npm\claude.cmd".to_string(),
                "--settings".to_string(),
                r"C:\Users\Ada Lovelace\settings.json".to_string(),
            ]
        );
    }

    #[test]
    fn rejects_unsafe_metacharacters() {
        for unsafe_arg in ["a%PATH%b", "a!b", "a&b", "a|b", "a>b", "a<b", "a^b", "a\"b"] {
            let result = wrap_for_cmd(
                Path::new(r"C:\npm\claude.cmd"),
                vec![unsafe_arg.to_string()],
                comspec(),
            );
            assert!(
                matches!(result, Err(ExecutorError::UnsafeWindowsBatchArguments(_))),
                "expected rejection for {unsafe_arg:?}"
            );
        }
    }

    #[test]
    fn rejects_newlines_in_arguments() {
        let result = wrap_for_cmd(
            Path::new(r"C:\npm\claude.cmd"),
            vec!["line1\nline2".to_string()],
            comspec(),
        );
        assert!(matches!(
            result,
            Err(ExecutorError::UnsafeWindowsBatchArguments(_))
        ));
    }

    #[test]
    fn rejects_unsafe_characters_in_program_path() {
        let result = wrap_for_cmd(Path::new(r"C:\weird&dir\claude.cmd"), vec![], comspec());
        assert!(matches!(
            result,
            Err(ExecutorError::UnsafeWindowsBatchArguments(_))
        ));
    }

    #[test]
    fn comspec_honors_env_then_system_root_then_default() {
        use std::ffi::OsString;

        assert_eq!(
            comspec_from(Some(OsString::from(r"D:\alt\cmd.exe")), None),
            PathBuf::from(r"D:\alt\cmd.exe"),
        );
        assert_eq!(
            comspec_from(None, Some(OsString::from(r"C:\WinNT"))),
            PathBuf::from(r"C:\WinNT\System32\cmd.exe"),
        );
        assert_eq!(
            comspec_from(None, None),
            PathBuf::from(r"C:\Windows\System32\cmd.exe"),
        );
    }

    #[test]
    fn non_windows_prepare_is_identity() {
        // On the CI host (non-Windows) even a `.cmd` path passes through
        // unchanged, because the batch-shim problem is Windows-only.
        #[cfg(not(windows))]
        {
            let invocation = prepare_invocation(
                PathBuf::from("/usr/local/bin/claude"),
                vec!["--version".to_string()],
            )
            .expect("identity");
            assert_eq!(invocation.program, PathBuf::from("/usr/local/bin/claude"));
            assert_eq!(invocation.args, vec!["--version".to_string()]);
        }
    }
}
