//! Boolean full-text query language for content search.
//!
//! Mirrors the common, universally-applicable subset of the Obsidian search
//! grammar so a repository behaves the same way a vault does:
//!
//! - Implicit `AND` between space-separated terms, explicit `OR`, `-` negation,
//!   and `(` `)` grouping.
//! - `"exact phrase"` literal matches and `/regex/` patterns.
//! - Field prefixes: `file:`, `path:`, `content:` (default), `tag:`.
//! - Same-line scoping: `line:(a b)` (or `line:a` for a single term).
//! - Case control: `match-case:`, `ignore-case:`; otherwise the caller's
//!   default (smart-case: sensitive only when the term has an uppercase letter).
//!
//! Markdown-structure operators (`section:`, `block:`, `task:`, `[property]`)
//! are intentionally out of scope: they need a document model this content
//! walker does not build.

use std::collections::BTreeMap;

use regex::{Regex, RegexBuilder};

/// A byte range `[start, end)` within a single line.
pub type ByteRange = (usize, usize);
/// Highlights collected during evaluation, keyed by 1-based line number.
pub type Highlights = BTreeMap<u64, Vec<ByteRange>>;

/// A parsed query ready to evaluate against files.
#[derive(Debug)]
pub struct CompiledQuery {
    root: Node,
    /// Whether evaluating this query requires reading file contents. When false
    /// (only name/path terms), callers can skip content I/O entirely.
    pub reads_content: bool,
}

#[derive(Debug)]
enum Node {
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Box<Node>),
    Term(Term),
    /// All inner terms must match within the same line.
    ScopedLine(Box<Node>),
    /// Always matches, contributes no highlights (e.g. an empty group).
    Any,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    Content,
    File,
    Path,
}

#[derive(Debug)]
struct Term {
    field: Field,
    kind: MatchKind,
}

#[derive(Debug)]
enum MatchKind {
    /// Case-sensitivity is baked in: for insensitive matches the needle is
    /// already lowercased and the haystack is lowercased at match time.
    Text { needle: String, case_sensitive: bool },
    Regex(Regex),
}

/// Error compiling a query (currently only invalid regex).
#[derive(Debug)]
pub struct QueryError(pub String);

impl CompiledQuery {
    /// Parse `input`. `default_case` is `Some(true/false)` to force
    /// sensitivity, or `None` for smart-case per term.
    pub fn parse(input: &str, default_case: Option<bool>) -> Result<Self, QueryError> {
        let tokens = tokenize(input);
        let mut parser = Parser {
            tokens: &tokens,
            pos: 0,
            default_case,
        };
        let root = parser.parse_or()?;
        let reads_content = node_reads_content(&root);
        Ok(Self { root, reads_content })
    }

    /// Evaluate against one file. `name` is the file path (used by `file:` and
    /// `path:` terms). `lines` are the file's lines without trailing newlines;
    /// pass an empty slice when `reads_content` is false.
    ///
    /// Returns `Some(highlights)` when the file matches (highlights may be
    /// empty for name-only or negated matches), or `None` when it does not.
    pub fn evaluate(&self, name: &str, lines: &[&str]) -> Option<Highlights> {
        eval(&self.root, name, lines)
    }

    /// True when the query has no terms at all (blank input).
    pub fn is_empty(&self) -> bool {
        matches!(self.root, Node::Any)
    }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    LParen,
    RParen,
    Or,
    Minus,
    /// A leaf: optional `field:` prefix already split off, plus the raw matcher.
    Word(String),
}

/// Split input into tokens, respecting quotes, regex slashes, and parentheses.
fn tokenize(input: &str) -> Vec<Token> {
    let chars: Vec<char> = input.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '(' {
            tokens.push(Token::LParen);
            i += 1;
            continue;
        }
        if c == ')' {
            tokens.push(Token::RParen);
            i += 1;
            continue;
        }
        if c == '-' {
            // A leading '-' is negation only when it starts a term.
            tokens.push(Token::Minus);
            i += 1;
            continue;
        }
        // Read a word, keeping quoted spans and /regex/ spans intact, and
        // stopping at whitespace or an unquoted paren.
        let start = i;
        let mut word = String::new();
        while i < chars.len() {
            let ch = chars[i];
            if ch.is_whitespace() || ch == '(' || ch == ')' {
                break;
            }
            if ch == '"' {
                word.push(ch);
                i += 1;
                while i < chars.len() {
                    word.push(chars[i]);
                    let closed = chars[i] == '"' && chars[i - 1] != '\\';
                    i += 1;
                    if closed {
                        break;
                    }
                }
                continue;
            }
            if ch == '/' && i == start {
                // Only treat a leading slash as a regex delimiter.
                word.push(ch);
                i += 1;
                while i < chars.len() {
                    word.push(chars[i]);
                    let closed = chars[i] == '/';
                    i += 1;
                    if closed {
                        break;
                    }
                }
                continue;
            }
            word.push(ch);
            i += 1;
        }
        if word == "OR" {
            tokens.push(Token::Or);
        } else if !word.is_empty() {
            tokens.push(Token::Word(word));
        }
    }
    tokens
}

// ---------------------------------------------------------------------------
// Parser (recursive descent): or := and ("OR" and)*, and := unary+,
// unary := "-" unary | atom, atom := "(" or ")" | term
// ---------------------------------------------------------------------------

struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
    default_case: Option<bool>,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn parse_or(&mut self) -> Result<Node, QueryError> {
        let mut branches = vec![self.parse_and()?];
        while matches!(self.peek(), Some(Token::Or)) {
            self.pos += 1;
            branches.push(self.parse_and()?);
        }
        Ok(if branches.len() == 1 {
            branches.pop().unwrap()
        } else {
            Node::Or(branches)
        })
    }

    fn parse_and(&mut self) -> Result<Node, QueryError> {
        let mut terms = Vec::new();
        while let Some(tok) = self.peek() {
            if matches!(tok, Token::Or | Token::RParen) {
                break;
            }
            terms.push(self.parse_unary()?);
        }
        Ok(match terms.len() {
            0 => Node::Any,
            1 => terms.pop().unwrap(),
            _ => Node::And(terms),
        })
    }

    fn parse_unary(&mut self) -> Result<Node, QueryError> {
        if matches!(self.peek(), Some(Token::Minus)) {
            self.pos += 1;
            let inner = self.parse_unary()?;
            return Ok(Node::Not(Box::new(inner)));
        }
        self.parse_atom()
    }

    fn parse_atom(&mut self) -> Result<Node, QueryError> {
        match self.peek() {
            Some(Token::LParen) => {
                self.pos += 1;
                let inner = self.parse_or()?;
                if matches!(self.peek(), Some(Token::RParen)) {
                    self.pos += 1;
                }
                Ok(inner)
            }
            Some(Token::Word(word)) => {
                let word = word.clone();
                self.pos += 1;
                self.compile_word(&word)
            }
            // A stray OR/Minus/RParen with no operand: treat as no-op.
            _ => {
                self.pos += 1;
                Ok(Node::Any)
            }
        }
    }

    /// Turn a single word (with optional `field:` prefix) into a node.
    fn compile_word(&mut self, word: &str) -> Result<Node, QueryError> {
        // Split an optional field prefix: `field:value`.
        if let Some((prefix, rest)) = split_field(word) {
            match prefix.as_str() {
                "file" => return self.leaf(Field::File, rest),
                "path" => return self.leaf(Field::Path, rest),
                "content" => return self.leaf(Field::Content, rest),
                "match-case" => return self.leaf_cased(Field::Content, rest, Some(true)),
                "ignore-case" => return self.leaf_cased(Field::Content, rest, Some(false)),
                "tag" => {
                    // tag:work and tag:#work both search the literal "#work".
                    let tag = rest.strip_prefix('#').unwrap_or(rest);
                    return self.leaf(Field::Content, &format!("#{tag}"));
                }
                "line" => {
                    // line:(a b) scopes a sub-query; line:a scopes one term.
                    let inner = if rest.is_empty() {
                        // `line:` followed by a parenthesized group.
                        self.parse_atom()?
                    } else {
                        self.leaf(Field::Content, rest)?
                    };
                    return Ok(Node::ScopedLine(Box::new(inner)));
                }
                _ => {}
            }
        }
        self.leaf(Field::Content, word)
    }

    fn leaf(&self, field: Field, value: &str) -> Result<Node, QueryError> {
        self.leaf_cased(field, value, self.default_case)
    }

    fn leaf_cased(
        &self,
        field: Field,
        value: &str,
        case: Option<bool>,
    ) -> Result<Node, QueryError> {
        let value = value.trim();
        if value.is_empty() {
            return Ok(Node::Any);
        }
        // /regex/
        if value.len() >= 2 && value.starts_with('/') && value.ends_with('/') {
            let pattern = &value[1..value.len() - 1];
            let case_insensitive = matches!(case, Some(false))
                || (case.is_none() && !has_uppercase(pattern));
            let regex = RegexBuilder::new(pattern)
                .case_insensitive(case_insensitive)
                .build()
                .map_err(|e| QueryError(format!("invalid regex: {e}")))?;
            return Ok(Node::Term(Term {
                field,
                kind: MatchKind::Regex(regex),
            }));
        }
        // "exact phrase" (strip surrounding quotes, unescape \")
        let needle = if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
            value[1..value.len() - 1].replace("\\\"", "\"")
        } else {
            value.to_string()
        };
        let case_sensitive = match case {
            Some(cs) => cs,
            None => has_uppercase(&needle),
        };
        let needle = if case_sensitive {
            needle
        } else {
            needle.to_lowercase()
        };
        Ok(Node::Term(Term {
            field,
            kind: MatchKind::Text {
                needle,
                case_sensitive,
            },
        }))
    }
}

/// Split `field:value` into `(field, value)` when `field` is a known operator
/// prefix. Guards against splitting things like URLs or Windows paths by only
/// matching a lowercase-letter/hyphen prefix.
fn split_field(word: &str) -> Option<(String, &str)> {
    let colon = word.find(':')?;
    let prefix = &word[..colon];
    if prefix.is_empty()
        || !prefix
            .chars()
            .all(|c| c.is_ascii_lowercase() || c == '-')
    {
        return None;
    }
    Some((prefix.to_string(), &word[colon + 1..]))
}

fn has_uppercase(text: &str) -> bool {
    text.chars().any(char::is_uppercase)
}

fn node_reads_content(node: &Node) -> bool {
    match node {
        Node::Term(t) => t.field == Field::Content,
        Node::ScopedLine(_) => true,
        Node::Not(inner) => node_reads_content(inner),
        Node::And(kids) | Node::Or(kids) => kids.iter().any(node_reads_content),
        Node::Any => false,
    }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

fn eval(node: &Node, name: &str, lines: &[&str]) -> Option<Highlights> {
    match node {
        Node::Any => Some(Highlights::new()),
        Node::Term(term) => eval_term(term, name, lines),
        Node::Not(inner) => match eval(inner, name, lines) {
            Some(_) => None,
            None => Some(Highlights::new()),
        },
        Node::And(kids) => {
            let mut merged = Highlights::new();
            for kid in kids {
                let h = eval(kid, name, lines)?;
                merge_into(&mut merged, h);
            }
            Some(merged)
        }
        Node::Or(kids) => {
            let mut merged = Highlights::new();
            let mut any = false;
            for kid in kids {
                if let Some(h) = eval(kid, name, lines) {
                    any = true;
                    merge_into(&mut merged, h);
                }
            }
            if any {
                Some(merged)
            } else {
                None
            }
        }
        Node::ScopedLine(inner) => {
            let mut merged = Highlights::new();
            let mut any = false;
            for (idx, line) in lines.iter().enumerate() {
                let single = [*line];
                if let Some(h) = eval(inner, name, &single) {
                    any = true;
                    // Re-key the single-line highlights (line 1) to the real number.
                    if let Some(ranges) = h.get(&1) {
                        merged
                            .entry(idx as u64 + 1)
                            .or_default()
                            .extend(ranges.iter().copied());
                    }
                }
            }
            if any {
                Some(merged)
            } else {
                None
            }
        }
    }
}

fn eval_term(term: &Term, name: &str, lines: &[&str]) -> Option<Highlights> {
    match term.field {
        Field::File => {
            let base = name.rsplit('/').next().unwrap_or(name);
            if term_matches_str(term, base) {
                Some(Highlights::new())
            } else {
                None
            }
        }
        Field::Path => {
            if term_matches_str(term, name) {
                Some(Highlights::new())
            } else {
                None
            }
        }
        Field::Content => {
            let mut highlights = Highlights::new();
            for (idx, line) in lines.iter().enumerate() {
                let ranges = term_ranges(term, line);
                if !ranges.is_empty() {
                    highlights.insert(idx as u64 + 1, ranges);
                }
            }
            if highlights.is_empty() {
                None
            } else {
                Some(highlights)
            }
        }
    }
}

/// Whether a name/path term matches a string (no ranges needed).
fn term_matches_str(term: &Term, haystack: &str) -> bool {
    match &term.kind {
        MatchKind::Text {
            needle,
            case_sensitive,
        } => {
            if *case_sensitive {
                haystack.contains(needle.as_str())
            } else {
                haystack.to_lowercase().contains(needle.as_str())
            }
        }
        MatchKind::Regex(re) => re.is_match(haystack),
    }
}

/// All match byte-ranges of a content term within a single line.
fn term_ranges(term: &Term, line: &str) -> Vec<ByteRange> {
    match &term.kind {
        MatchKind::Text {
            needle,
            case_sensitive,
        } => {
            if needle.is_empty() {
                return Vec::new();
            }
            let mut ranges = Vec::new();
            if *case_sensitive {
                let mut from = 0;
                while let Some(rel) = line[from..].find(needle.as_str()) {
                    let start = from + rel;
                    let end = start + needle.len();
                    ranges.push((start, end));
                    from = end;
                }
            } else {
                // Match on a lowercased copy, then map offsets back. Lengths can
                // differ under Unicode case folding, so only trust the mapping
                // when they line up; otherwise skip highlighting this line.
                let lower = line.to_lowercase();
                if lower.len() != line.len() {
                    return if lower.contains(needle.as_str()) {
                        // Fall back to a single whole-line-free match set: no
                        // reliable offsets, so report none (still counts as a
                        // match via the caller checking emptiness) — but we must
                        // return at least one range to signal a match. Use the
                        // first occurrence clamped to a char boundary.
                        first_range_clamped(line, &lower, needle)
                    } else {
                        Vec::new()
                    };
                }
                let mut from = 0;
                while let Some(rel) = lower[from..].find(needle.as_str()) {
                    let start = from + rel;
                    let end = start + needle.len();
                    ranges.push((start, end));
                    from = end;
                }
            }
            ranges
        }
        MatchKind::Regex(re) => re
            .find_iter(line)
            .map(|m| (m.start(), m.end()))
            .collect(),
    }
}

/// Best-effort single range when case-folding changed the string length.
fn first_range_clamped(line: &str, lower: &str, needle: &str) -> Vec<ByteRange> {
    let Some(pos) = lower.find(needle) else {
        return Vec::new();
    };
    let start = floor_char_boundary(line, pos.min(line.len()));
    let end = ceil_char_boundary(line, (pos + needle.len()).min(line.len()));
    if end > start {
        vec![(start, end)]
    } else {
        vec![]
    }
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

fn merge_into(dst: &mut Highlights, src: Highlights) {
    for (line, ranges) in src {
        dst.entry(line).or_default().extend(ranges);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(query: &str, name: &str, content: &str) -> Option<Vec<u64>> {
        let compiled = CompiledQuery::parse(query, None).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        compiled
            .evaluate(name, &lines)
            .map(|h| h.keys().copied().collect())
    }

    #[test]
    fn implicit_and_requires_all_terms() {
        // Both terms present (different lines) → match.
        assert!(run("foo bar", "a.txt", "foo here\nbar there\n").is_some());
        // Missing one term → no match.
        assert!(run("foo baz", "a.txt", "foo here\nbar there\n").is_none());
    }

    #[test]
    fn or_matches_either() {
        assert!(run("foo OR baz", "a.txt", "only baz\n").is_some());
        assert!(run("qux OR baz", "a.txt", "nothing\n").is_none());
    }

    #[test]
    fn negation_excludes() {
        assert!(run("foo -bar", "a.txt", "foo alone\n").is_some());
        assert!(run("foo -bar", "a.txt", "foo and bar\n").is_none());
    }

    #[test]
    fn grouping_controls_precedence() {
        // foo AND (bar OR baz)
        assert!(run("foo (bar OR baz)", "a.txt", "foo\nbaz\n").is_some());
        assert!(run("foo (bar OR baz)", "a.txt", "foo only\n").is_none());
    }

    #[test]
    fn exact_phrase_is_literal() {
        assert!(run("\"foo bar\"", "a.txt", "foo bar baz\n").is_some());
        assert!(run("\"foo bar\"", "a.txt", "foo then bar\n").is_none());
    }

    #[test]
    fn regex_term() {
        assert!(run("/\\d{4}-\\d{2}/", "a.txt", "date 2026-07 today\n").is_some());
        assert!(run("/\\d{4}-\\d{2}/", "a.txt", "no digits\n").is_none());
    }

    #[test]
    fn file_and_path_fields_do_not_read_content() {
        let q = CompiledQuery::parse("file:report", None).unwrap();
        assert!(!q.reads_content);
        assert!(q.evaluate("dir/report.md", &[]).is_some());
        assert!(q.evaluate("dir/other.md", &[]).is_none());

        let p = CompiledQuery::parse("path:dir/", None).unwrap();
        assert!(p.evaluate("dir/report.md", &[]).is_some());
        assert!(p.evaluate("elsewhere/report.md", &[]).is_none());
    }

    #[test]
    fn file_term_combines_with_content_term() {
        // file:a.md AND content "hello"
        let q = CompiledQuery::parse("file:a.md hello", None).unwrap();
        assert!(q.reads_content);
        assert!(q.evaluate("a.md", &["say hello"]).is_some());
        assert!(q.evaluate("b.md", &["say hello"]).is_none());
        assert!(q.evaluate("a.md", &["no greeting"]).is_none());
    }

    #[test]
    fn line_scope_requires_same_line() {
        assert!(run("line:(foo bar)", "a.txt", "foo and bar together\n").is_some());
        assert!(run("line:(foo bar)", "a.txt", "foo up here\nbar down there\n").is_none());
    }

    #[test]
    fn tag_matches_hash_prefixed_word() {
        assert!(run("tag:#work", "a.txt", "todo #work item\n").is_some());
        assert!(run("tag:work", "a.txt", "todo #work item\n").is_some());
        assert!(run("tag:work", "a.txt", "plain work\n").is_none());
    }

    #[test]
    fn smart_case_and_overrides() {
        // Smart-case: lowercase query is insensitive.
        assert!(run("needle", "a.txt", "NEEDLE\n").is_some());
        // Uppercase query is sensitive.
        assert!(run("Needle", "a.txt", "needle\n").is_none());
        // Forced overrides.
        assert!(run("match-case:needle", "a.txt", "NEEDLE\n").is_none());
        assert!(run("ignore-case:Needle", "a.txt", "needle\n").is_some());
    }

    #[test]
    fn highlights_cover_all_positive_terms() {
        let compiled = CompiledQuery::parse("foo bar", None).unwrap();
        let h = compiled
            .evaluate("a.txt", &["foo here", "bar there", "foo and bar"])
            .unwrap();
        // Lines 1, 2, 3 all carry a positive-term match.
        assert_eq!(h.keys().copied().collect::<Vec<_>>(), vec![1, 2, 3]);
        // Line 3 has both foo and bar highlighted.
        assert_eq!(h[&3].len(), 2);
    }

    #[test]
    fn blank_query_is_empty() {
        let q = CompiledQuery::parse("   ", None).unwrap();
        assert!(q.is_empty());
    }
}
