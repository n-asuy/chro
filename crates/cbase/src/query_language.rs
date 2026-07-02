//! A compact, SQL-flavored query language that compiles to a `.cbase`
//! definition.
//!
//! `TABLE <fields> FROM <source> WHERE <expr> SORT <fields> LIMIT <n>` is parsed
//! into a single-view table definition. Sources (`#tag`, `"path"`) and `WHERE`
//! expressions become filters; column references and sort keys are interned into
//! a synthesized property schema.

use std::collections::HashMap;
use std::sync::OnceLock;

use indexmap::IndexMap;
use regex::Regex;
use serde_json::Value as JsonValue;

use crate::types::{
    CbaseDataset, CbaseDefinition, CbaseFilter, CbaseFilterCondition, CbaseProperty,
    CbasePropertyType, CbaseSort, CbaseTableView, CbaseView, FilterOperator, SortDirection,
};

type ParseResult<T> = Result<T, String>;

/// Optional document metadata supplied when the query is embedded in YAML.
#[derive(Default)]
pub struct Meta {
    pub name: Option<String>,
    pub description: Option<String>,
}

fn query_start_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^(TABLE|LIST|TASK|CALENDAR)\b").unwrap())
}

fn clause_start_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(TABLE|LIST|TASK|CALENDAR|FROM|WHERE|SORT|LIMIT|GROUP BY|FLATTEN)\b")
            .unwrap()
    })
}

fn simple_field_ref_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_.-]*$").unwrap())
}

/// True when the content begins with a query-language header clause.
pub fn looks_like_query_language(content: &str) -> bool {
    let normalized = strip_query_fence(content);
    let normalized = normalized.trim();
    if normalized.is_empty() {
        return false;
    }
    for raw_line in normalized.split('\n') {
        let line = strip_inline_comment(raw_line.trim_end_matches('\r'));
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        return query_start_re().is_match(line);
    }
    false
}

#[derive(Clone)]
enum SourceNode {
    Tag(String),
    Path(String),
    And(Box<SourceNode>, Box<SourceNode>),
    Or(Box<SourceNode>, Box<SourceNode>),
    Not(Box<SourceNode>),
}

#[derive(Clone)]
enum WhereNode {
    Literal(JsonValue),
    Field(String),
    Call {
        name: String,
        args: Vec<WhereNode>,
    },
    Binary {
        op: String,
        left: Box<WhereNode>,
        right: Box<WhereNode>,
    },
    Not(Box<WhereNode>),
}

struct ParsedHeaderField {
    raw: String,
    #[allow(dead_code)]
    alias: Option<String>,
}

struct ParsedSortField {
    raw: String,
    dir: SortDirection,
}

struct ParsedQueryLanguage {
    type_name: String,
    fields: Vec<ParsedHeaderField>,
    source: Option<SourceNode>,
    where_clauses: Vec<WhereNode>,
    sort: Vec<ParsedSortField>,
    limit: Option<i64>,
}

fn resolve_default_dataset_include(base_path: Option<&str>) -> Vec<String> {
    let normalized = base_path.unwrap_or("").replace('\\', "/");
    let normalized = normalized.trim_start_matches('/');
    if normalized.is_empty() {
        return vec!["**/*.md".to_string()];
    }
    match normalized.rfind('/') {
        None => vec!["**/*.md".to_string()],
        Some(index) => {
            let folder = &normalized[..index];
            if folder.is_empty() {
                vec!["**/*.md".to_string()]
            } else {
                vec![format!("{folder}/**/*.md")]
            }
        }
    }
}

/// Compile a query-language string into a single-view table definition.
pub fn parse_to_definition(
    raw_query: &str,
    meta: Option<Meta>,
    base_path: Option<&str>,
) -> ParseResult<CbaseDefinition> {
    let parsed = parse_query_language(raw_query)?;
    if parsed.type_name != "table" {
        return Err(format!(
            "Only TABLE queries are supported in .cbase for now (received {})",
            parsed.type_name.to_uppercase()
        ));
    }

    let meta = meta.unwrap_or_default();
    let mut registry = PropertyRegistry::new();
    let mut filters: Vec<CbaseFilter> = Vec::new();

    if let Some(source) = &parsed.source {
        if let Some(filter) = source_node_to_filter(source, &mut registry) {
            filters.push(filter);
        }
    }

    for where_node in &parsed.where_clauses {
        if let Some(filter) = where_node_to_filter(where_node, &mut registry)? {
            filters.push(filter);
        }
    }

    let sort: Vec<CbaseSort> = parsed
        .sort
        .iter()
        .map(|entry| CbaseSort {
            by: registry.ensure(&entry.raw, None),
            dir: entry.dir,
        })
        .collect();

    let mut table_columns: Vec<String> = Vec::new();
    for field in &parsed.fields {
        if !simple_field_ref_re().is_match(&field.raw) {
            continue;
        }
        table_columns.push(registry.ensure(&field.raw, None));
    }

    if registry.properties.is_empty() {
        registry.ensure("file.name", Some(CbasePropertyType::Text));
    }

    let resolved_columns = if table_columns.is_empty() {
        registry.properties.keys().cloned().collect()
    } else {
        table_columns
    };

    let dataset_include = if parsed.source.is_some() {
        vec!["**/*.md".to_string()]
    } else {
        resolve_default_dataset_include(base_path)
    };

    Ok(CbaseDefinition {
        version: 1,
        name: meta.name.unwrap_or_else(|| "Query Language".to_string()),
        description: meta.description,
        dataset: CbaseDataset {
            include: dataset_include,
            exclude: None,
        },
        properties: registry.properties,
        filters: if filters.is_empty() {
            None
        } else {
            Some(filters)
        },
        sort: if sort.is_empty() { None } else { Some(sort) },
        views: vec![CbaseView {
            id: "default".to_string(),
            name: "All".to_string(),
            view_type: "table".to_string(),
            default: Some(true),
            filters: None,
            sort: None,
            limit: parsed.limit,
            table: Some(CbaseTableView {
                columns: resolved_columns,
                column_widths: None,
                row_height: None,
            }),
        }],
        template: None,
    })
}

fn parse_query_language(raw: &str) -> ParseResult<ParsedQueryLanguage> {
    let stripped = strip_query_fence(raw);
    let query = stripped.trim();
    if query.is_empty() {
        return Err("Query is empty".to_string());
    }

    let clauses = split_clauses(query)?;
    if clauses.is_empty() {
        return Err("Query is empty".to_string());
    }

    let (type_name, fields) = parse_header_clause(&clauses[0])?;
    let mut parsed = ParsedQueryLanguage {
        type_name,
        fields,
        source: None,
        where_clauses: Vec::new(),
        sort: Vec::new(),
        limit: None,
    };

    let mut seen_from = false;
    let mut seen_limit = false;

    for clause in clauses.iter().skip(1) {
        if starts_with_keyword(clause, "FROM") {
            if seen_from {
                return Err("Only one FROM clause is supported".to_string());
            }
            seen_from = true;
            let source_text = strip_leading_keyword(clause, "FROM");
            if source_text.is_empty() {
                return Err("FROM requires a source".to_string());
            }
            parsed.source = Some(parse_source_expression(&source_text)?);
            continue;
        }

        if starts_with_keyword(clause, "WHERE") {
            let expr_text = strip_leading_keyword(clause, "WHERE");
            if expr_text.is_empty() {
                return Err("WHERE requires an expression".to_string());
            }
            parsed
                .where_clauses
                .push(parse_where_expression(&expr_text)?);
            continue;
        }

        if starts_with_keyword(clause, "SORT") {
            let sort_text = strip_leading_keyword(clause, "SORT");
            if sort_text.is_empty() {
                return Err("SORT requires at least one field".to_string());
            }
            parsed.sort.extend(parse_sort_fields(&sort_text)?);
            continue;
        }

        if starts_with_keyword(clause, "LIMIT") {
            if seen_limit {
                return Err("Only one LIMIT clause is supported".to_string());
            }
            seen_limit = true;
            let limit_text = strip_leading_keyword(clause, "LIMIT");
            if limit_text.is_empty() || !limit_text.chars().all(|c| c.is_ascii_digit()) {
                return Err("LIMIT currently supports only integer literals".to_string());
            }
            parsed.limit = limit_text.parse::<i64>().ok();
            continue;
        }

        if regex_is_match(r"(?i)^GROUP\s+BY\b", clause) {
            return Err("GROUP BY is not supported in .cbase yet".to_string());
        }

        if starts_with_keyword(clause, "FLATTEN") {
            return Err("FLATTEN is not supported in .cbase yet".to_string());
        }

        return Err(format!("Unsupported clause: {clause}"));
    }

    Ok(parsed)
}

/// Whether a clause starts with `keyword` followed by a word boundary.
fn starts_with_keyword(clause: &str, keyword: &str) -> bool {
    regex_is_match(&format!(r"(?i)^{keyword}\b"), clause)
}

/// Strip a leading `keyword` plus following whitespace from a clause.
fn strip_leading_keyword(clause: &str, keyword: &str) -> String {
    let re = Regex::new(&format!(r"(?i)^{keyword}\s+")).unwrap();
    re.replace(clause, "").trim().to_string()
}

fn regex_is_match(pattern: &str, text: &str) -> bool {
    Regex::new(pattern)
        .map(|re| re.is_match(text))
        .unwrap_or(false)
}

fn parse_header_clause(clause: &str) -> ParseResult<(String, Vec<ParsedHeaderField>)> {
    let re = Regex::new(r"(?is)^(TABLE|LIST|TASK|CALENDAR)\b(.*)$").unwrap();
    let captures = re
        .captures(clause)
        .ok_or_else(|| "Query must start with TABLE/LIST/TASK/CALENDAR".to_string())?;

    let type_name = captures[1].to_lowercase();
    let mut rest = captures
        .get(2)
        .map(|m| m.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let without_id = Regex::new(r"(?i)^WITHOUT\s+ID\b").unwrap();
    if without_id.is_match(&rest) {
        rest = without_id.replace(&rest, "").trim().to_string();
    }

    if type_name != "table" && !rest.is_empty() {
        return Err(format!(
            "{} with custom fields is not supported in .cbase yet",
            type_name.to_uppercase()
        ));
    }

    let fields = if type_name == "table" && !rest.is_empty() {
        split_top_level(&rest, ',')
            .iter()
            .map(|field| parse_header_field(field))
            .collect::<ParseResult<Vec<_>>>()?
    } else {
        Vec::new()
    };

    Ok((type_name, fields))
}

fn parse_header_field(raw_field: &str) -> ParseResult<ParsedHeaderField> {
    let text = raw_field.trim();
    if text.is_empty() {
        return Err("TABLE has an empty field".to_string());
    }

    let alias_re = Regex::new(r"(?i)^(.*?)(?:\s+AS\s+)(.+)$").unwrap();
    match alias_re.captures(text) {
        None => Ok(ParsedHeaderField {
            raw: text.to_string(),
            alias: None,
        }),
        Some(captures) => Ok(ParsedHeaderField {
            raw: captures[1].trim().to_string(),
            alias: Some(unquote(captures[2].trim())),
        }),
    }
}

fn parse_sort_fields(raw: &str) -> ParseResult<Vec<ParsedSortField>> {
    let sort_re = Regex::new(r"(?i)^(.*?)(?:\s+(ASCENDING|DESCENDING|ASC|DESC))?$").unwrap();
    split_top_level(raw, ',')
        .iter()
        .map(|part| {
            let text = part.trim();
            if text.is_empty() {
                return Err("SORT has an empty field entry".to_string());
            }
            let captures = sort_re
                .captures(text)
                .ok_or_else(|| format!("Invalid SORT field: {text}"))?;
            let raw_field = captures[1].trim().to_string();
            if !simple_field_ref_re().is_match(&raw_field) {
                return Err(format!(
                    "SORT currently supports only plain field references (got: {raw_field})"
                ));
            }
            let dir_token = captures.get(2).map(|m| m.as_str().to_lowercase());
            let dir = match dir_token.as_deref() {
                Some("desc") | Some("descending") => SortDirection::Desc,
                _ => SortDirection::Asc,
            };
            Ok(ParsedSortField {
                raw: raw_field,
                dir,
            })
        })
        .collect()
}

fn source_node_to_filter(
    node: &SourceNode,
    registry: &mut PropertyRegistry,
) -> Option<CbaseFilter> {
    match node {
        SourceNode::Tag(value) => {
            let property = registry.ensure("tags", Some(CbasePropertyType::MultiSelect));
            let normalized_tag = value.strip_prefix('#').unwrap_or(value).to_string();
            Some(CbaseFilter::Or {
                or: vec![
                    condition(
                        &property,
                        FilterOperator::Contains,
                        Some(json_str(&normalized_tag)),
                    ),
                    condition(
                        &property,
                        FilterOperator::Contains,
                        Some(json_str(&format!("#{normalized_tag}"))),
                    ),
                ],
            })
        }
        SourceNode::Path(value) => {
            let path = value.trim_matches('/').to_string();
            if path.is_empty() {
                return None;
            }
            let property = registry.ensure("file.path", Some(CbasePropertyType::Text));
            if path.ends_with(".md") {
                Some(condition(
                    &property,
                    FilterOperator::Eq,
                    Some(json_str(&path)),
                ))
            } else {
                Some(condition(
                    &property,
                    FilterOperator::StartsWith,
                    Some(json_str(&format!("{path}/"))),
                ))
            }
        }
        SourceNode::Not(child) => {
            source_node_to_filter(child, registry).map(|inner| CbaseFilter::Not {
                not: Box::new(inner),
            })
        }
        SourceNode::And(left, right) => {
            let left = source_node_to_filter(left, registry);
            let right = source_node_to_filter(right, registry);
            match (left, right) {
                (Some(l), Some(r)) => Some(CbaseFilter::And { and: vec![l, r] }),
                (l, r) => l.or(r),
            }
        }
        SourceNode::Or(left, right) => {
            let left = source_node_to_filter(left, registry);
            let right = source_node_to_filter(right, registry);
            match (left, right) {
                (Some(l), Some(r)) => Some(CbaseFilter::Or { or: vec![l, r] }),
                (l, r) => l.or(r),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// FROM source expression parsing
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq)]
enum SourceTok {
    Tag(String),
    Str(String),
    And,
    Or,
    Minus,
    LParen,
    RParen,
    Eof,
}

fn parse_source_expression(source_text: &str) -> ParseResult<SourceNode> {
    if source_text.contains("[[") || regex_is_match(r"(?i)\boutgoing\s*\(", source_text) {
        return Err("Link-based FROM sources are not supported in .cbase yet".to_string());
    }

    let tokens = tokenize_source(source_text)?;
    let mut cursor = TokenCursor::new(tokens);
    let result = parse_source_or(&mut cursor)?;
    if cursor.peek() != &SourceTok::Eof {
        return Err(format!(
            "Unexpected token in FROM source: '{}'",
            source_tok_text(cursor.peek())
        ));
    }
    Ok(result)
}

struct TokenCursor {
    tokens: Vec<SourceTok>,
    index: usize,
}

impl TokenCursor {
    fn new(tokens: Vec<SourceTok>) -> Self {
        Self { tokens, index: 0 }
    }
    fn peek(&self) -> &SourceTok {
        self.tokens.get(self.index).unwrap_or(&SourceTok::Eof)
    }
    fn next(&mut self) -> SourceTok {
        let tok = self
            .tokens
            .get(self.index)
            .cloned()
            .unwrap_or(SourceTok::Eof);
        self.index += 1;
        tok
    }
}

fn parse_source_or(cursor: &mut TokenCursor) -> ParseResult<SourceNode> {
    let mut left = parse_source_and(cursor)?;
    while cursor.peek() == &SourceTok::Or {
        cursor.next();
        let right = parse_source_and(cursor)?;
        left = SourceNode::Or(Box::new(left), Box::new(right));
    }
    Ok(left)
}

fn parse_source_and(cursor: &mut TokenCursor) -> ParseResult<SourceNode> {
    let mut left = parse_source_unary(cursor)?;
    while cursor.peek() == &SourceTok::And {
        cursor.next();
        let right = parse_source_unary(cursor)?;
        left = SourceNode::And(Box::new(left), Box::new(right));
    }
    Ok(left)
}

fn parse_source_unary(cursor: &mut TokenCursor) -> ParseResult<SourceNode> {
    if cursor.peek() == &SourceTok::Minus {
        cursor.next();
        return Ok(SourceNode::Not(Box::new(parse_source_unary(cursor)?)));
    }
    parse_source_primary(cursor)
}

fn parse_source_primary(cursor: &mut TokenCursor) -> ParseResult<SourceNode> {
    match cursor.peek().clone() {
        SourceTok::Str(value) => {
            cursor.next();
            Ok(SourceNode::Path(value))
        }
        SourceTok::Tag(value) => {
            cursor.next();
            Ok(SourceNode::Tag(value))
        }
        SourceTok::LParen => {
            cursor.next();
            let expr = parse_source_or(cursor)?;
            if cursor.peek() != &SourceTok::RParen {
                return Err(format!(
                    "Expected rparen in FROM source, got {}",
                    source_tok_kind(cursor.peek())
                ));
            }
            cursor.next();
            Ok(expr)
        }
        other => Err(format!(
            "Invalid FROM source token: '{}'",
            non_empty(source_tok_text(&other), source_tok_kind(&other))
        )),
    }
}

fn tokenize_source(text: &str) -> ParseResult<Vec<SourceTok>> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];

        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        match ch {
            '(' => {
                tokens.push(SourceTok::LParen);
                i += 1;
                continue;
            }
            ')' => {
                tokens.push(SourceTok::RParen);
                i += 1;
                continue;
            }
            '-' => {
                tokens.push(SourceTok::Minus);
                i += 1;
                continue;
            }
            '"' | '\'' => {
                let (value, next) = read_quoted(&chars, i)?;
                tokens.push(SourceTok::Str(value));
                i = next;
                continue;
            }
            '#' => {
                let mut j = i + 1;
                while j < chars.len()
                    && !chars[j].is_whitespace()
                    && chars[j] != '('
                    && chars[j] != ')'
                {
                    j += 1;
                }
                tokens.push(SourceTok::Tag(chars[i..j].iter().collect()));
                i = j;
                continue;
            }
            _ => {}
        }

        if let Some(keyword) = read_keyword(&chars, i) {
            match keyword.to_uppercase().as_str() {
                "AND" => tokens.push(SourceTok::And),
                "OR" => tokens.push(SourceTok::Or),
                _ => {
                    return Err(format!(
                        "Unsupported token in FROM source near: '{}'",
                        slice_preview(&chars, i)
                    ))
                }
            }
            i += keyword.chars().count();
            continue;
        }

        return Err(format!(
            "Unsupported token in FROM source near: '{}'",
            slice_preview(&chars, i)
        ));
    }

    tokens.push(SourceTok::Eof);
    Ok(tokens)
}

/// Read a leading run of word characters (used to recognize AND/OR keywords).
fn read_keyword(chars: &[char], start: usize) -> Option<String> {
    let mut j = start;
    while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
        j += 1;
    }
    if j == start {
        None
    } else {
        Some(chars[start..j].iter().collect())
    }
}

fn source_tok_text(tok: &SourceTok) -> String {
    match tok {
        SourceTok::Tag(s) | SourceTok::Str(s) => s.clone(),
        SourceTok::And => "AND".to_string(),
        SourceTok::Or => "OR".to_string(),
        SourceTok::Minus => "-".to_string(),
        SourceTok::LParen => "(".to_string(),
        SourceTok::RParen => ")".to_string(),
        SourceTok::Eof => String::new(),
    }
}

fn source_tok_kind(tok: &SourceTok) -> &'static str {
    match tok {
        SourceTok::Tag(_) => "tag",
        SourceTok::Str(_) => "string",
        SourceTok::And => "and",
        SourceTok::Or => "or",
        SourceTok::Minus => "minus",
        SourceTok::LParen => "lparen",
        SourceTok::RParen => "rparen",
        SourceTok::Eof => "eof",
    }
}

// ---------------------------------------------------------------------------
// WHERE expression parsing
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq)]
enum WhereTok {
    Ident(String),
    Num(JsonValue),
    Str(String),
    Bool(bool),
    Null,
    And,
    Or,
    Not,
    Bang,
    Op(String),
    Comma,
    LParen,
    RParen,
    Eof,
}

struct WhereCursor {
    tokens: Vec<WhereTok>,
    index: usize,
}

impl WhereCursor {
    fn new(tokens: Vec<WhereTok>) -> Self {
        Self { tokens, index: 0 }
    }
    fn peek(&self) -> &WhereTok {
        self.tokens.get(self.index).unwrap_or(&WhereTok::Eof)
    }
    fn next(&mut self) -> WhereTok {
        let tok = self
            .tokens
            .get(self.index)
            .cloned()
            .unwrap_or(WhereTok::Eof);
        self.index += 1;
        tok
    }
}

fn parse_where_expression(raw: &str) -> ParseResult<WhereNode> {
    let tokens = tokenize_where(raw)?;
    let mut cursor = WhereCursor::new(tokens);
    let result = parse_where_or(&mut cursor)?;
    if cursor.peek() != &WhereTok::Eof {
        return Err(format!(
            "Unexpected token in WHERE expression: '{}'",
            non_empty(where_tok_text(cursor.peek()), where_tok_kind(cursor.peek()))
        ));
    }
    Ok(result)
}

fn parse_where_or(cursor: &mut WhereCursor) -> ParseResult<WhereNode> {
    let mut left = parse_where_and(cursor)?;
    while cursor.peek() == &WhereTok::Or {
        cursor.next();
        let right = parse_where_and(cursor)?;
        left = WhereNode::Binary {
            op: "or".to_string(),
            left: Box::new(left),
            right: Box::new(right),
        };
    }
    Ok(left)
}

fn parse_where_and(cursor: &mut WhereCursor) -> ParseResult<WhereNode> {
    let mut left = parse_where_not(cursor)?;
    while cursor.peek() == &WhereTok::And {
        cursor.next();
        let right = parse_where_not(cursor)?;
        left = WhereNode::Binary {
            op: "and".to_string(),
            left: Box::new(left),
            right: Box::new(right),
        };
    }
    Ok(left)
}

fn parse_where_not(cursor: &mut WhereCursor) -> ParseResult<WhereNode> {
    if matches!(cursor.peek(), WhereTok::Not | WhereTok::Bang) {
        cursor.next();
        return Ok(WhereNode::Not(Box::new(parse_where_not(cursor)?)));
    }
    parse_where_comparison(cursor)
}

fn parse_where_comparison(cursor: &mut WhereCursor) -> ParseResult<WhereNode> {
    let left = parse_where_primary(cursor)?;
    let WhereTok::Op(_) = cursor.peek() else {
        return Ok(left);
    };
    let WhereTok::Op(operator) = cursor.next() else {
        unreachable!()
    };
    let right = parse_where_primary(cursor)?;
    Ok(WhereNode::Binary {
        op: operator,
        left: Box::new(left),
        right: Box::new(right),
    })
}

fn parse_where_primary(cursor: &mut WhereCursor) -> ParseResult<WhereNode> {
    match cursor.peek().clone() {
        WhereTok::LParen => {
            cursor.next();
            let expr = parse_where_or(cursor)?;
            if cursor.peek() != &WhereTok::RParen {
                return Err(format!(
                    "Expected rparen in WHERE expression, got {}",
                    where_tok_kind(cursor.peek())
                ));
            }
            cursor.next();
            Ok(expr)
        }
        WhereTok::Ident(field_name) => {
            cursor.next();
            if cursor.peek() == &WhereTok::LParen {
                cursor.next();
                let mut args = Vec::new();
                if cursor.peek() != &WhereTok::RParen {
                    loop {
                        args.push(parse_where_or(cursor)?);
                        if cursor.peek() == &WhereTok::Comma {
                            cursor.next();
                            continue;
                        }
                        break;
                    }
                }
                if cursor.peek() != &WhereTok::RParen {
                    return Err(format!(
                        "Expected rparen in WHERE expression, got {}",
                        where_tok_kind(cursor.peek())
                    ));
                }
                cursor.next();
                return Ok(WhereNode::Call {
                    name: field_name,
                    args,
                });
            }
            Ok(WhereNode::Field(field_name))
        }
        WhereTok::Num(value) => {
            cursor.next();
            Ok(WhereNode::Literal(value))
        }
        WhereTok::Str(value) => {
            cursor.next();
            Ok(WhereNode::Literal(JsonValue::String(value)))
        }
        WhereTok::Bool(value) => {
            cursor.next();
            Ok(WhereNode::Literal(JsonValue::Bool(value)))
        }
        WhereTok::Null => {
            cursor.next();
            Ok(WhereNode::Literal(JsonValue::Null))
        }
        other => Err(format!(
            "Invalid WHERE token: '{}'",
            non_empty(where_tok_text(&other), where_tok_kind(&other))
        )),
    }
}

fn tokenize_where(text: &str) -> ParseResult<Vec<WhereTok>> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];

        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        match ch {
            '(' => {
                tokens.push(WhereTok::LParen);
                i += 1;
                continue;
            }
            ')' => {
                tokens.push(WhereTok::RParen);
                i += 1;
                continue;
            }
            ',' => {
                tokens.push(WhereTok::Comma);
                i += 1;
                continue;
            }
            '!' => {
                if chars.get(i + 1) == Some(&'=') {
                    tokens.push(WhereTok::Op("!=".to_string()));
                    i += 2;
                } else {
                    tokens.push(WhereTok::Bang);
                    i += 1;
                }
                continue;
            }
            '<' | '>' | '=' => {
                if chars.get(i + 1) == Some(&'=') {
                    tokens.push(WhereTok::Op(format!("{ch}=")));
                    i += 2;
                } else {
                    tokens.push(WhereTok::Op(ch.to_string()));
                    i += 1;
                }
                continue;
            }
            '"' | '\'' => {
                let (value, next) = read_quoted(&chars, i)?;
                tokens.push(WhereTok::Str(value));
                i = next;
                continue;
            }
            _ => {}
        }

        if let Some((value, next)) = read_number(&chars, i) {
            tokens.push(WhereTok::Num(value));
            i = next;
            continue;
        }

        if let Some((ident, next)) = read_ident(&chars, i) {
            let upper = ident.to_uppercase();
            match upper.as_str() {
                "AND" => tokens.push(WhereTok::And),
                "OR" => tokens.push(WhereTok::Or),
                "NOT" => tokens.push(WhereTok::Not),
                "TRUE" => tokens.push(WhereTok::Bool(true)),
                "FALSE" => tokens.push(WhereTok::Bool(false)),
                "NULL" => tokens.push(WhereTok::Null),
                _ => tokens.push(WhereTok::Ident(ident)),
            }
            i = next;
            continue;
        }

        return Err(format!(
            "Unsupported token in WHERE expression near: '{}'",
            slice_preview(&chars, i)
        ));
    }

    tokens.push(WhereTok::Eof);
    Ok(tokens)
}

/// Read a numeric literal `-?\d+(?:\.\d+)?`, preserving integer-ness.
fn read_number(chars: &[char], start: usize) -> Option<(JsonValue, usize)> {
    let mut j = start;
    if chars.get(j) == Some(&'-') {
        j += 1;
    }
    let digits_start = j;
    while j < chars.len() && chars[j].is_ascii_digit() {
        j += 1;
    }
    if j == digits_start {
        return None;
    }
    let mut is_float = false;
    if chars.get(j) == Some(&'.') && chars.get(j + 1).is_some_and(|c| c.is_ascii_digit()) {
        is_float = true;
        j += 1;
        while j < chars.len() && chars[j].is_ascii_digit() {
            j += 1;
        }
    }
    let literal: String = chars[start..j].iter().collect();
    let value = if is_float {
        serde_json::Number::from_f64(literal.parse::<f64>().ok()?).map(JsonValue::Number)?
    } else {
        JsonValue::Number(literal.parse::<i64>().ok()?.into())
    };
    Some((value, j))
}

/// Read an identifier `[A-Za-z_][A-Za-z0-9_.-]*`.
fn read_ident(chars: &[char], start: usize) -> Option<(String, usize)> {
    let first = *chars.get(start)?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let mut j = start + 1;
    while j < chars.len() {
        let c = chars[j];
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
            j += 1;
        } else {
            break;
        }
    }
    Some((chars[start..j].iter().collect(), j))
}

fn where_node_to_filter(
    node: &WhereNode,
    registry: &mut PropertyRegistry,
) -> ParseResult<Option<CbaseFilter>> {
    match node {
        WhereNode::Binary { op, left, right } => {
            if op == "and" || op == "or" {
                let left = where_node_to_filter(left, registry)?;
                let right = where_node_to_filter(right, registry)?;
                return Ok(match (left, right) {
                    (Some(l), Some(r)) => Some(if op == "and" {
                        CbaseFilter::And { and: vec![l, r] }
                    } else {
                        CbaseFilter::Or { or: vec![l, r] }
                    }),
                    (l, r) => l.or(r),
                });
            }
            comparison_to_filter(op, left, right, registry).map(Some)
        }
        WhereNode::Not(expr) => {
            Ok(
                where_node_to_filter(expr, registry)?.map(|inner| CbaseFilter::Not {
                    not: Box::new(inner),
                }),
            )
        }
        WhereNode::Field(name) => {
            let property = registry.ensure(name, None);
            Ok(Some(condition(&property, FilterOperator::IsNotEmpty, None)))
        }
        WhereNode::Call { name, args } => function_call_to_filter(name, args, registry).map(Some),
        WhereNode::Literal(value) => match value {
            JsonValue::Bool(true) => Ok(None),
            JsonValue::Bool(false) => Err("WHERE false is not supported in .cbase yet".to_string()),
            _ => Err("WHERE literal expression is not supported without a field".to_string()),
        },
    }
}

fn comparison_to_filter(
    op: &str,
    left: &WhereNode,
    right: &WhereNode,
    registry: &mut PropertyRegistry,
) -> ParseResult<CbaseFilter> {
    let left_field = field_name(left);
    let right_field = field_name(right);
    let left_literal = literal_value(left);
    let right_literal = literal_value(right);

    if let (Some(l), Some(r)) = (&left_field, &right_field) {
        return Err(format!(
            "WHERE comparison between two fields is not supported ({l} {op} {r})"
        ));
    }

    if let (Some(field), Some(value)) = (&left_field, &right_literal) {
        return build_comparison_filter(field, op, value, registry);
    }

    if let (Some(field), Some(value)) = (&right_field, &left_literal) {
        return build_comparison_filter(field, &reverse_comparison_op(op), value, registry);
    }

    Err("WHERE comparisons currently require one field and one literal".to_string())
}

fn function_call_to_filter(
    name: &str,
    args: &[WhereNode],
    registry: &mut PropertyRegistry,
) -> ParseResult<CbaseFilter> {
    let lower = name.to_lowercase();

    if [
        "contains",
        "startswith",
        "starts_with",
        "endswith",
        "ends_with",
    ]
    .contains(&lower.as_str())
    {
        if args.len() != 2 {
            return Err(format!("{name}() requires exactly 2 arguments"));
        }
        let WhereNode::Field(field) = &args[0] else {
            return Err(format!("{name}() first argument must be a field"));
        };
        let WhereNode::Literal(value) = &args[1] else {
            return Err(format!("{name}() second argument must be a literal"));
        };
        let property = registry.ensure(field, None);
        let op = match lower.as_str() {
            "contains" => FilterOperator::Contains,
            "startswith" | "starts_with" => FilterOperator::StartsWith,
            _ => FilterOperator::EndsWith,
        };
        return Ok(condition(&property, op, Some(value.clone())));
    }

    if ["isempty", "is_empty"].contains(&lower.as_str()) {
        let field = match args.first() {
            Some(WhereNode::Field(field)) if args.len() == 1 => field,
            _ => return Err(format!("{name}() requires exactly one field argument")),
        };
        return Ok(condition(
            &registry.ensure(field, None),
            FilterOperator::IsEmpty,
            None,
        ));
    }

    Err(format!(
        "Unsupported WHERE function '{name}()' in .cbase mode"
    ))
}

fn build_comparison_filter(
    field: &str,
    op: &str,
    value: &JsonValue,
    registry: &mut PropertyRegistry,
) -> ParseResult<CbaseFilter> {
    let property = registry.ensure(field, infer_type_from_literal(value));

    if value.is_null() {
        return match op {
            "=" => Ok(condition(&property, FilterOperator::IsEmpty, None)),
            "!=" => Ok(condition(&property, FilterOperator::IsNotEmpty, None)),
            _ => Err(format!("Operator {op} is not valid with NULL in WHERE")),
        };
    }

    let operator = comparison_operator(op)
        .ok_or_else(|| format!("Unsupported binary operator '{op}' in WHERE"))?;
    Ok(condition(&property, operator, Some(value.clone())))
}

fn comparison_operator(op: &str) -> Option<FilterOperator> {
    match op {
        "=" => Some(FilterOperator::Eq),
        "!=" => Some(FilterOperator::Ne),
        "<" => Some(FilterOperator::Lt),
        ">" => Some(FilterOperator::Gt),
        "<=" => Some(FilterOperator::Le),
        ">=" => Some(FilterOperator::Ge),
        _ => None,
    }
}

fn reverse_comparison_op(op: &str) -> String {
    match op {
        "<" => ">",
        ">" => "<",
        "<=" => ">=",
        ">=" => "<=",
        other => other,
    }
    .to_string()
}

fn infer_type_from_literal(value: &JsonValue) -> Option<CbasePropertyType> {
    match value {
        JsonValue::Number(_) => Some(CbasePropertyType::Number),
        JsonValue::Bool(_) => Some(CbasePropertyType::Checkbox),
        _ => None,
    }
}

fn field_name(node: &WhereNode) -> Option<String> {
    match node {
        WhereNode::Field(name) => Some(name.clone()),
        _ => None,
    }
}

fn literal_value(node: &WhereNode) -> Option<JsonValue> {
    match node {
        WhereNode::Literal(value) => Some(value.clone()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Property registry: interns field references into a synthesized schema
// ---------------------------------------------------------------------------

struct PropertyRegistry {
    properties: IndexMap<String, CbaseProperty>,
    by_key: HashMap<String, String>,
}

impl PropertyRegistry {
    fn new() -> Self {
        Self {
            properties: IndexMap::new(),
            by_key: HashMap::new(),
        }
    }

    fn ensure(&mut self, key: &str, hint: Option<CbasePropertyType>) -> String {
        let normalized_key = key.trim().to_string();
        if let Some(existing) = self.by_key.get(&normalized_key).cloned() {
            self.apply_type_hint(&existing, hint);
            return existing;
        }

        let base = sanitize_id(&normalized_key);
        let mut id = base.clone();
        let mut suffix = 2;
        while self.properties.contains_key(&id) {
            id = format!("{base}_{suffix}");
            suffix += 1;
        }

        self.by_key.insert(normalized_key.clone(), id.clone());
        self.properties.insert(
            id.clone(),
            CbaseProperty::new(
                normalized_key.clone(),
                hint.unwrap_or_else(|| infer_type_from_key(&normalized_key)),
            ),
        );
        id
    }

    fn apply_type_hint(&mut self, id: &str, hint: Option<CbasePropertyType>) {
        let Some(hint) = hint else { return };
        if let Some(prop) = self.properties.get_mut(id) {
            if prop.property_type == CbasePropertyType::Text && prop.property_type != hint {
                prop.property_type = hint;
            }
        }
    }
}

fn infer_type_from_key(key: &str) -> CbasePropertyType {
    let lower = key.to_lowercase();
    if lower == "tags" || lower.ends_with(".tags") {
        return CbasePropertyType::MultiSelect;
    }
    if lower == "file.mtime" || lower.ends_with(".date") {
        return CbasePropertyType::Date;
    }
    CbasePropertyType::Text
}

fn sanitize_id(key: &str) -> String {
    let lower = key.to_lowercase();
    let mut slug = String::new();
    let mut prev_underscore = false;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_underscore = false;
        } else if !prev_underscore {
            slug.push('_');
            prev_underscore = true;
        }
    }
    let slug = slug.trim_matches('_');
    if slug.is_empty() {
        "p_field".to_string()
    } else {
        format!("p_{slug}")
    }
}

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

fn split_clauses(query: &str) -> ParseResult<Vec<String>> {
    let mut clauses = Vec::new();
    let mut current = String::new();

    for raw_line in query.split('\n') {
        let line = strip_inline_comment(raw_line.trim_end_matches('\r'));
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if clause_start_re().is_match(line) {
            if !current.is_empty() {
                clauses.push(current.trim().to_string());
            }
            current = line.to_string();
            continue;
        }

        if current.is_empty() {
            return Err(format!("Unexpected text before first clause: '{line}'"));
        }

        current.push(' ');
        current.push_str(line);
    }

    if !current.is_empty() {
        clauses.push(current.trim().to_string());
    }
    Ok(clauses)
}

fn split_top_level(text: &str, separator: char) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut result = Vec::new();
    let mut depth = 0i32;
    let mut in_single = false;
    let mut in_double = false;
    let mut start = 0usize;
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];

        if ch == '\\' {
            i += 2;
            continue;
        }
        if !in_double && ch == '\'' {
            in_single = !in_single;
            i += 1;
            continue;
        }
        if !in_single && ch == '"' {
            in_double = !in_double;
            i += 1;
            continue;
        }
        if in_single || in_double {
            i += 1;
            continue;
        }
        if ch == '(' || ch == '[' || ch == '{' {
            depth += 1;
            i += 1;
            continue;
        }
        if ch == ')' || ch == ']' || ch == '}' {
            depth = (depth - 1).max(0);
            i += 1;
            continue;
        }
        if depth == 0 && ch == separator {
            result.push(
                chars[start..i]
                    .iter()
                    .collect::<String>()
                    .trim()
                    .to_string(),
            );
            start = i + 1;
        }
        i += 1;
    }

    result.push(chars[start..].iter().collect::<String>().trim().to_string());
    result.into_iter().filter(|s| !s.is_empty()).collect()
}

fn strip_inline_comment(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        if ch == '\\' {
            i += 2;
            continue;
        }
        if !in_double && ch == '\'' {
            in_single = !in_single;
            i += 1;
            continue;
        }
        if !in_single && ch == '"' {
            in_double = !in_double;
            i += 1;
            continue;
        }
        if !in_single && !in_double && ch == '/' && chars.get(i + 1) == Some(&'/') {
            return chars[..i].iter().collect();
        }
        i += 1;
    }
    line.to_string()
}

fn strip_query_fence(raw: &str) -> String {
    let trimmed = raw.trim();
    let fence = Regex::new(r"(?s)^```(?:[A-Za-z0-9_-]+)?\s*\n(.*?)\n```$").unwrap();
    if let Some(captures) = fence.captures(trimmed) {
        return captures
            .get(1)
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();
    }
    raw.to_string()
}

fn read_quoted(chars: &[char], start: usize) -> ParseResult<(String, usize)> {
    let quote = *chars
        .get(start)
        .ok_or_else(|| "Expected quoted string".to_string())?;
    let mut i = start + 1;
    let mut value = String::new();

    while i < chars.len() {
        let ch = chars[i];
        if ch == '\\' {
            let next = chars
                .get(i + 1)
                .ok_or_else(|| "Unterminated escape sequence in string".to_string())?;
            value.push(*next);
            i += 2;
            continue;
        }
        if ch == quote {
            return Ok((value, i + 1));
        }
        value.push(ch);
        i += 1;
    }

    Err("Unterminated string literal".to_string())
}

fn unquote(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() >= 2 {
        let head = chars[0];
        let tail = chars[chars.len() - 1];
        if (head == '"' && tail == '"') || (head == '\'' && tail == '\'') {
            return chars[1..chars.len() - 1].iter().collect();
        }
    }
    text.to_string()
}

fn slice_preview(chars: &[char], start: usize) -> String {
    let end = (start + 16).min(chars.len());
    chars[start..end].iter().collect()
}

fn non_empty(text: String, fallback: &str) -> String {
    if text.is_empty() {
        fallback.to_string()
    } else {
        text
    }
}

fn where_tok_text(tok: &WhereTok) -> String {
    match tok {
        WhereTok::Ident(s) | WhereTok::Op(s) => s.clone(),
        WhereTok::Str(s) => s.clone(),
        WhereTok::Num(v) => v.to_string(),
        WhereTok::Bool(b) => b.to_string(),
        WhereTok::Null => "null".to_string(),
        WhereTok::And => "and".to_string(),
        WhereTok::Or => "or".to_string(),
        WhereTok::Not => "not".to_string(),
        WhereTok::Bang => "!".to_string(),
        WhereTok::Comma => ",".to_string(),
        WhereTok::LParen => "(".to_string(),
        WhereTok::RParen => ")".to_string(),
        WhereTok::Eof => String::new(),
    }
}

fn where_tok_kind(tok: &WhereTok) -> &'static str {
    match tok {
        WhereTok::Ident(_) => "ident",
        WhereTok::Num(_) => "number",
        WhereTok::Str(_) => "string",
        WhereTok::Bool(_) => "boolean",
        WhereTok::Null => "null",
        WhereTok::And => "and",
        WhereTok::Or => "or",
        WhereTok::Not => "not",
        WhereTok::Bang => "bang",
        WhereTok::Op(_) => "op",
        WhereTok::Comma => "comma",
        WhereTok::LParen => "lparen",
        WhereTok::RParen => "rparen",
        WhereTok::Eof => "eof",
    }
}

fn condition(property: &str, op: FilterOperator, value: Option<JsonValue>) -> CbaseFilter {
    CbaseFilter::Condition(CbaseFilterCondition {
        property: property.to_string(),
        op,
        value,
    })
}

fn json_str(value: &str) -> JsonValue {
    JsonValue::String(value.to_string())
}
