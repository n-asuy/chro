//! The MCP configuration as a paired device sees it: credentials hidden.
//!
//! MCP server entries carry API keys in `env`, authorization headers, and
//! tokens inside arguments and URLs. A phone may read and edit the entries,
//! but secret values stay on the computer:
//!
//! - [`redact_servers`] replaces every secret value with [`HIDDEN`]. A whole
//!   value (an `env` or header value, a `token` field) becomes exactly
//!   `HIDDEN`; a secret inside a string (a URL query value, `--key=...`,
//!   `Authorization: Bearer ...`) has just that part replaced.
//! - [`restore_servers`] puts the hidden values back into an edited copy
//!   before it is saved: a string still holding `HIDDEN` takes the original
//!   it was made from, in the same server and the same object or array. A string that cannot be traced
//!   back (the server was renamed, or the visible part around a hidden one
//!   was edited) is refused, so a placeholder never overwrites a credential.
//! - [`redact_text`] hides secrets in free text such as a status line.

use serde_json::{Map, Value};

/// What a hidden secret reads as on a device.
pub(crate) const HIDDEN: &str = "__chro_hidden__";

/// Objects whose every string value is a secret.
const SECRET_MAPS: &[&str] = &["env", "environment", "headers", "http_headers"];

/// Prefixes of well-known credential formats.
const TOKEN_PREFIXES: &[&str] = &[
    "sk-",
    "sk_",
    "pk_live_",
    "rk_live_",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xoxs-",
    "xapp-",
    "AKIA",
    "ASIA",
    "AIza",
    "ya29.",
    "eyJ",
    "npm_",
    "hf_",
    "shpat_",
    "dop_v1_",
];

/// Whether a key, flag or header name names a credential.
fn is_secret_name(name: &str) -> bool {
    let normalized: String = name
        .trim_start_matches('-')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    const PARTS: &[&str] = &[
        "token",
        "secret",
        "password",
        "passwd",
        "apikey",
        "accesskey",
        "privatekey",
        "credential",
        "auth",
        "bearer",
        "cookie",
        "sessionid",
        "signature",
    ];
    PARTS.iter().any(|part| normalized.contains(part)) || normalized.ends_with("key")
}

/// Whether a bare word looks like a credential by its shape.
fn is_token_like(word: &str) -> bool {
    if TOKEN_PREFIXES
        .iter()
        .any(|prefix| word.starts_with(prefix) && word.len() >= prefix.len() + 8)
    {
        return true;
    }
    word.len() >= 32
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'+' | b'=' | b'.'))
        && word.bytes().any(|b| b.is_ascii_digit())
        && word.bytes().any(|b| b.is_ascii_alphabetic())
}

/// Hide the secret parts of one URL: the password (or a bare token) before
/// `@`, and query values named like credentials or shaped like one.
fn redact_url(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let (scheme, rest) = url.split_at(scheme_end + 3);
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    let authority = match authority.rfind('@') {
        Some(at) => {
            let (userinfo, host) = authority.split_at(at);
            match userinfo.split_once(':') {
                Some((user, _)) => format!("{user}:{HIDDEN}{host}"),
                None => format!("{HIDDEN}{host}"),
            }
        }
        None => authority.to_string(),
    };
    let (before_fragment, fragment) = match tail.find('#') {
        Some(at) => tail.split_at(at),
        None => (tail, ""),
    };
    let tail = match before_fragment.split_once('?') {
        Some((path, query)) => {
            let query: Vec<String> = query
                .split('&')
                .map(|pair| match pair.split_once('=') {
                    Some((name, value))
                        if !value.is_empty() && (is_secret_name(name) || is_token_like(value)) =>
                    {
                        format!("{name}={HIDDEN}")
                    }
                    _ => pair.to_string(),
                })
                .collect();
            format!("{path}?{}", query.join("&"))
        }
        None => before_fragment.to_string(),
    };
    format!("{scheme}{authority}{tail}{fragment}")
}

/// Hide one whitespace-free word of free text.
fn redact_word(word: &str) -> String {
    if word.contains("://") {
        return redact_url(word);
    }
    if let Some((name, value)) = word.split_once('=') {
        if !value.is_empty() && (is_secret_name(name) || is_token_like(value)) {
            return format!("{name}={HIDDEN}");
        }
        return word.to_string();
    }
    if is_token_like(word) {
        return HIDDEN.to_string();
    }
    word.to_string()
}

/// Hide secrets inside free text: URLs, `NAME=value` and `--name=value`
/// with a credential name, the credential after `Bearer`/`Basic`/`Token`,
/// the value of a `Name: value` header with a credential name, and words
/// shaped like a known token. Whitespace is kept as it was.
pub(crate) fn redact_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut hide_next = false;
    let mut rest = text;
    while !rest.is_empty() {
        let space_end = rest
            .find(|c: char| !c.is_whitespace())
            .unwrap_or(rest.len());
        out.push_str(&rest[..space_end]);
        rest = &rest[space_end..];
        if rest.is_empty() {
            break;
        }
        let word_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let word = &rest[..word_end];
        rest = &rest[word_end..];
        if hide_next {
            out.push_str(HIDDEN);
            hide_next = false;
        } else if word.strip_suffix(':').is_some_and(is_secret_name) {
            // `Authorization: Bearer x`: the rest of the text is the value.
            out.push_str(word);
            if !rest.trim().is_empty() {
                out.push(' ');
                out.push_str(HIDDEN);
            }
            break;
        } else if matches!(
            word.to_ascii_lowercase().as_str(),
            "bearer" | "basic" | "token"
        ) {
            out.push_str(word);
            hide_next = true;
        } else {
            out.push_str(&redact_word(word));
        }
    }
    out
}

/// One step into a JSON value.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Step {
    Key(String),
    Index(usize),
}

/// A string the redaction changed: where it was, and both forms.
struct Hidden {
    path: Vec<Step>,
    original: String,
    redacted: String,
}

/// How the string at a position is treated.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Context {
    /// Free text: hide only the secret parts.
    Text,
    /// The whole string is a secret.
    Secret,
}

fn redact_value(
    value: &Value,
    context: Context,
    path: &mut Vec<Step>,
    hidden: &mut Vec<Hidden>,
) -> Value {
    match value {
        Value::String(text) => {
            let redacted = match context {
                Context::Secret if !text.is_empty() => HIDDEN.to_string(),
                Context::Secret => text.clone(),
                Context::Text => redact_text(text),
            };
            if redacted != *text {
                hidden.push(Hidden {
                    path: path.clone(),
                    original: text.clone(),
                    redacted: redacted.clone(),
                });
            }
            Value::String(redacted)
        }
        Value::Array(items) => {
            let mut secret_flag = false;
            let items = items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    // `["--api-key", "sk-..."]`: the word after a credential
                    // flag is the credential.
                    let item_context = if secret_flag {
                        Context::Secret
                    } else {
                        context
                    };
                    secret_flag = item.as_str().is_some_and(|arg| {
                        arg.starts_with('-') && !arg.contains('=') && is_secret_name(arg)
                    });
                    path.push(Step::Index(index));
                    let redacted = redact_value(item, item_context, path, hidden);
                    path.pop();
                    redacted
                })
                .collect();
            Value::Array(items)
        }
        Value::Object(map) => {
            let map = map
                .iter()
                .map(|(key, item)| {
                    let item_context = if context == Context::Secret
                        || is_secret_name(key)
                        || (SECRET_MAPS.contains(&key.as_str()) && item.is_object())
                    {
                        Context::Secret
                    } else {
                        Context::Text
                    };
                    path.push(Step::Key(key.clone()));
                    let redacted = redact_value(item, item_context, path, hidden);
                    path.pop();
                    (key.clone(), redacted)
                })
                .collect();
            Value::Object(map)
        }
        other => other.clone(),
    }
}

fn redact_server(server: &Value) -> (Value, Vec<Hidden>) {
    let mut hidden = Vec::new();
    let redacted = redact_value(server, Context::Text, &mut Vec::new(), &mut hidden);
    (redacted, hidden)
}

/// The MCP servers with every secret value replaced by [`HIDDEN`].
pub(crate) fn redact_servers(servers: &Map<String, Value>) -> Map<String, Value> {
    servers
        .iter()
        .map(|(name, server)| (name.clone(), redact_server(server).0))
        .collect()
}

/// Why an edited configuration could not take its hidden values back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RestoreError {
    pub server: String,
}

impl std::fmt::Display for RestoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MCP server {:?} holds a hidden value that no longer matches the computer's configuration; edit hidden values on the computer, or replace the whole value",
            self.server
        )
    }
}

impl std::error::Error for RestoreError {}

/// Put the hidden values of `current` back into the edited `incoming`
/// servers. A string holding [`HIDDEN`] must equal the redacted form of a
/// string of the same server in `current`: the one at the same position,
/// else the only original with that redacted form in the same object or
/// array. Anything else is an error, never written.
pub(crate) fn restore_servers(
    incoming: Value,
    current: &Map<String, Value>,
) -> Result<Value, RestoreError> {
    let Value::Object(servers) = incoming else {
        return Ok(incoming);
    };
    servers
        .into_iter()
        .map(|(name, server)| {
            let hidden = current
                .get(&name)
                .map(|original| redact_server(original).1)
                .unwrap_or_default();
            let restored =
                restore_value(server, &mut Vec::new(), &hidden).ok_or_else(|| RestoreError {
                    server: name.clone(),
                })?;
            Ok((name, restored))
        })
        .collect::<Result<Map<_, _>, _>>()
        .map(Value::Object)
}

fn restore_value(value: Value, path: &mut Vec<Step>, hidden: &[Hidden]) -> Option<Value> {
    match value {
        Value::String(text) if text.contains(HIDDEN) => {
            restore_string(&text, path, hidden).map(Value::String)
        }
        Value::Array(items) => items
            .into_iter()
            .enumerate()
            .map(|(index, item)| {
                path.push(Step::Index(index));
                let restored = restore_value(item, path, hidden);
                path.pop();
                restored
            })
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        Value::Object(map) => map
            .into_iter()
            .map(|(key, item)| {
                path.push(Step::Key(key.clone()));
                let restored = restore_value(item, path, hidden);
                path.pop();
                restored.map(|item| (key, item))
            })
            .collect::<Option<Map<_, _>>>()
            .map(Value::Object),
        other => Some(other),
    }
}

fn restore_string(text: &str, path: &[Step], hidden: &[Hidden]) -> Option<String> {
    if let Some(same_place) = hidden
        .iter()
        .find(|entry| entry.path == path && entry.redacted == text)
    {
        return Some(same_place.original.clone());
    }
    // Moved within its object or array (an argument inserted before it, a
    // key renamed): the only original of that form there.
    let parent = &path[..path.len().saturating_sub(1)];
    let mut originals = hidden
        .iter()
        .filter(|entry| entry.path.len() == path.len() && entry.path.starts_with(parent))
        .filter(|entry| entry.redacted == text)
        .map(|entry| entry.original.as_str());
    let first = originals.next()?;
    originals
        .all(|other| other == first)
        .then(|| first.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn servers(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    const OPENAI: &str = "sk-proj-4f9aLq2ZxV8mN3bR7tY1";
    const GITHUB: &str = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";

    fn config() -> Map<String, Value> {
        servers(json!({
            "search": {
                "command": "npx",
                "args": ["-y", "search-mcp", "--api-key", OPENAI, "--region=eu", "--token=abc123"],
                "env": {"OPENAI_API_KEY": OPENAI, "LOG_LEVEL": "debug", "EMPTY": ""}
            },
            "remote": {
                "type": "http",
                "url": "https://user:pa55word@mcp.example.com/v1/sse?api_key=k-123&team=core#top",
                "headers": {"Authorization": format!("Bearer {GITHUB}"), "X-Team": "core"}
            },
            "codex-style": {
                "command": "env GITHUB_TOKEN=gh-secret-value npx github-mcp",
                "bearer_token": "plain-secret",
                "http_headers": {"x-api-key": "zzz"},
                "startup_timeout_sec": 20
            }
        }))
    }

    #[test]
    fn every_secret_is_hidden_and_the_rest_is_kept() {
        let redacted = Value::Object(redact_servers(&config()));
        let text = redacted.to_string();
        for secret in [
            OPENAI,
            GITHUB,
            "pa55word",
            "k-123",
            "abc123",
            "gh-secret-value",
            "plain-secret",
            "zzz",
        ] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert_eq!(
            redacted["search"]["args"],
            json!([
                "-y",
                "search-mcp",
                "--api-key",
                HIDDEN,
                "--region=eu",
                format!("--token={HIDDEN}")
            ])
        );
        assert_eq!(redacted["search"]["env"]["OPENAI_API_KEY"], HIDDEN);
        assert_eq!(
            redacted["search"]["env"]["LOG_LEVEL"], HIDDEN,
            "every env value is a secret"
        );
        assert_eq!(redacted["search"]["env"]["EMPTY"], "", "nothing to hide");
        assert_eq!(
            redacted["remote"]["url"],
            format!("https://user:{HIDDEN}@mcp.example.com/v1/sse?api_key={HIDDEN}&team=core#top")
        );
        assert_eq!(redacted["remote"]["headers"]["Authorization"], HIDDEN);
        assert_eq!(redacted["remote"]["type"], "http");
        assert_eq!(
            redacted["codex-style"]["command"],
            format!("env GITHUB_TOKEN={HIDDEN} npx github-mcp")
        );
        assert_eq!(redacted["codex-style"]["bearer_token"], HIDDEN);
        assert_eq!(redacted["codex-style"]["startup_timeout_sec"], 20);
    }

    #[test]
    fn free_text_hides_header_values_and_bearer_tokens() {
        assert_eq!(
            redact_text("Authorization: Bearer abc def"),
            format!("Authorization: {HIDDEN}")
        );
        assert_eq!(
            redact_text("curl -H x Bearer abc ok"),
            format!("curl -H x Bearer {HIDDEN} ok")
        );
        assert_eq!(
            redact_text(&format!("npx tool {GITHUB}")),
            format!("npx tool {HIDDEN}")
        );
        assert_eq!(
            redact_text("npx -y @scope/server-files /Users/me/project"),
            "npx -y @scope/server-files /Users/me/project"
        );
        assert_eq!(redact_text("  spaced\tout  "), "  spaced\tout  ");
    }

    #[test]
    fn an_untouched_redacted_copy_restores_to_the_original() {
        let original = config();
        let edited = Value::Object(redact_servers(&original));
        assert_eq!(
            restore_servers(edited, &original).unwrap(),
            Value::Object(original)
        );
    }

    #[test]
    fn edits_keep_hidden_values_and_take_new_ones() {
        let original = config();
        let mut edited = Value::Object(redact_servers(&original));
        // Visible edits, an inserted argument shifting the hidden one, and a
        // secret replaced outright.
        edited["search"]["env"]["LOG_LEVEL"] = json!("info");
        edited["search"]["args"]
            .as_array_mut()
            .unwrap()
            .insert(0, json!("--quiet"));
        edited["remote"]["headers"]["Authorization"] = json!("Bearer new-token");
        edited["new-server"] = json!({"command": "uvx", "args": ["tool"]});

        let restored = restore_servers(edited, &original).unwrap();
        assert_eq!(restored["search"]["env"]["OPENAI_API_KEY"], OPENAI);
        assert_eq!(restored["search"]["env"]["LOG_LEVEL"], "info");
        assert_eq!(restored["search"]["args"][4], OPENAI, "moved with its flag");
        assert_eq!(restored["search"]["args"][6], "--token=abc123");
        assert_eq!(
            restored["remote"]["headers"]["Authorization"],
            "Bearer new-token"
        );
        assert_eq!(
            restored["remote"]["url"],
            "https://user:pa55word@mcp.example.com/v1/sse?api_key=k-123&team=core#top"
        );
        assert!(!restored.to_string().contains(HIDDEN));
    }

    #[test]
    fn a_placeholder_that_cannot_be_traced_back_is_refused() {
        let original = config();
        let redacted = Value::Object(redact_servers(&original));

        // A renamed server: its hidden values belonged to another name.
        let mut renamed = redacted.clone();
        let search = renamed.as_object_mut().unwrap().remove("search").unwrap();
        renamed["search-2"] = search;
        assert_eq!(
            restore_servers(renamed, &original).unwrap_err(),
            RestoreError {
                server: "search-2".into()
            }
        );

        // The visible part around a hidden one changed.
        let mut edited_url = redacted.clone();
        edited_url["remote"]["url"] = json!(format!("https://user:{HIDDEN}@other.example.com/"));
        assert!(restore_servers(edited_url, &original).is_err());

        // A placeholder typed where nothing was hidden.
        let mut typed = redacted;
        typed["remote"]["type"] = json!(HIDDEN);
        typed["remote"]["headers"]["X-Team"] = json!(HIDDEN);
        let restored = restore_servers(typed.clone(), &original);
        // `X-Team` was hidden (a header value) and restores; `type` was not.
        assert!(restored.is_err());
        typed["remote"]["type"] = json!("http");
        assert_eq!(
            restore_servers(typed, &original).unwrap()["remote"]["headers"]["X-Team"],
            "core"
        );
    }

    #[test]
    fn an_ambiguous_placeholder_is_refused() {
        let original = servers(json!({"s": {"env": {"A": "one", "B": "two"}}}));
        let mut edited = Value::Object(redact_servers(&original));
        // Moved to a key that held nothing: both originals read the same.
        edited["s"]["env"] = json!({"C": HIDDEN});
        assert!(restore_servers(edited, &original).is_err());
    }
}
