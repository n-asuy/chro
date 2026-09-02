//! Name matching and relevance scoring.
//!
//! A search result's rank is three independent components, combined so that a
//! stronger component always outweighs every weaker one:
//!
//! 1. **Tier** — *what kind* of match it is (the file's own name beats an
//!    alias beats a parent directory beats the rest of the path; a contiguous
//!    match beats a scattered one).
//! 2. **Refinement** — *how good* the match is within that kind: how early it
//!    starts, how little surrounding text it leaves over, how shallow the file
//!    sits, and (for fuzzy matches) how tightly the matched characters cluster.
//! 3. **History** — how recently and how often git touched the file, which
//!    breaks ties between otherwise equally good matches.
//!
//! Every comparison runs on [`crate::normalize_key`] output, so matching is
//! NFC-insensitive and case-insensitive throughout. One consequence: because
//! keys are lowercased, camelCase word boundaries are not visible to the fuzzy
//! scorer. Separator boundaries (`/`, `-`, `_`, `.`, space) are, and those are
//! what file names in practice are built from.

use crate::{normalize_key, SearchMatchType};

/// Coarse match quality. The ordinal is the primary sort key, so a weaker
/// tier can never be rescued by refinement or git history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum MatchTier {
    /// Query appears somewhere in the path, but not in the name, a parent
    /// directory name, or an alias.
    PathFuzzy = 1,
    PathSubstring,
    NameFuzzy,
    DirectorySubstring,
    AliasSubstring,
    NameSubstring,
    AliasPrefix,
    NamePrefix,
    AliasExact,
    /// The file's name is exactly the query.
    NameExact,
}

impl MatchTier {
    /// The public match kind reported to clients for this tier.
    fn match_type(self) -> SearchMatchType {
        match self {
            MatchTier::DirectorySubstring => SearchMatchType::DirectoryName,
            MatchTier::PathSubstring | MatchTier::PathFuzzy => SearchMatchType::FullPath,
            _ => SearchMatchType::FileName,
        }
    }
}

/// A scored match against one indexed entry.
#[derive(Debug, Clone, Copy)]
pub(crate) struct NameMatch {
    tier: MatchTier,
    /// Intra-tier quality, `0..=REFINEMENT_MAX`.
    refinement: i64,
}

impl NameMatch {
    pub(crate) fn match_type(&self) -> SearchMatchType {
        self.tier.match_type()
    }

    /// Combine the three ranking components into a single descending score.
    /// `history` is `0..=HISTORY_MAX`; see [`crate::history_score`].
    pub(crate) fn score(&self, history: i64) -> i64 {
        (self.tier as i64) * TIER_WEIGHT
            + self.refinement.clamp(0, REFINEMENT_MAX) * REFINEMENT_WEIGHT
            + history.clamp(0, HISTORY_MAX)
    }
}

/// Upper bound on the refinement component, and on the history component.
/// Each weight is one more than the range of everything below it, so the
/// components stack without ever bleeding into one another.
const REFINEMENT_MAX: i64 = 999;
pub(crate) const HISTORY_MAX: i64 = 999;
const REFINEMENT_WEIGHT: i64 = HISTORY_MAX + 1;
const TIER_WEIGHT: i64 = (REFINEMENT_MAX + 1) * REFINEMENT_WEIGHT;

/// Refinement is split into three sub-budgets that sum to [`REFINEMENT_MAX`].
const POSITION_BUDGET: i64 = 500;
const TIGHTNESS_BUDGET: i64 = 300;
const DEPTH_BUDGET: i64 = 199;

/// Characters that start a new word inside a file name or path. Matching a
/// query character right after one of these reads as a deliberate
/// abbreviation rather than a coincidence.
fn is_separator(c: char) -> bool {
    matches!(
        c,
        '/' | '\\' | '-' | '_' | '.' | ' ' | '(' | ')' | '[' | ']' | ',' | '+' | '@' | '~'
    )
}

/// `numerator / denominator` scaled into `0..=budget`, saturating at both
/// ends. Used to turn "how early", "how tight", "how shallow" into points.
fn scaled(numerator: usize, denominator: usize, budget: i64) -> i64 {
    if denominator == 0 {
        return budget;
    }
    let value = (numerator as i64).saturating_mul(budget) / denominator as i64;
    value.clamp(0, budget)
}

/// The `(basename, depth)` of a normalized relative path key.
fn basename_of(path_key: &str) -> (&str, usize) {
    let depth = path_key.matches('/').count();
    (path_key.rsplit('/').next().unwrap_or(path_key), depth)
}

/// A name with its final extension removed, or the name itself when it has
/// none. Typing `note` means the file named `note.md`: the extension is an
/// implementation detail the UI already hides and the resolver already
/// appends, so a stem hit counts as naming the file exactly.
fn stem_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(index) if index > 0 => &name[..index],
        _ => name,
    }
}

/// Points for a contiguous match: how early it starts in the field, how
/// little of the field is left over around it, and how shallow the file sits.
fn contiguous_refinement(field_len: usize, query_len: usize, position: usize, depth: usize) -> i64 {
    let position_points = scaled(
        field_len.saturating_sub(position),
        field_len,
        POSITION_BUDGET,
    );
    let tightness_points = scaled(query_len, field_len, TIGHTNESS_BUDGET);
    let depth_points = DEPTH_BUDGET / (1 + depth as i64);
    position_points + tightness_points + depth_points
}

/// Match `query_key` against one indexed entry using contiguous (substring)
/// matching only, which is what a user typing a name expects to win.
///
/// An empty query matches everything at the weakest tier with no refinement,
/// so ranking falls through to git history — that is the "most relevant files
/// with no query typed" listing.
pub(crate) fn match_contiguous(
    path_key: &str,
    alias_keys: &[std::sync::Arc<str>],
    query_key: &str,
) -> Option<NameMatch> {
    if query_key.is_empty() {
        return Some(NameMatch {
            tier: MatchTier::PathFuzzy,
            refinement: 0,
        });
    }

    let (name, depth) = basename_of(path_key);
    let query_len = query_key.chars().count();

    // The file's own name, strongest first.
    if let Some(position) = name.find(query_key) {
        let name_len = name.chars().count();
        let tier = if name == query_key || stem_of(name) == query_key {
            MatchTier::NameExact
        } else if position == 0 {
            MatchTier::NamePrefix
        } else {
            MatchTier::NameSubstring
        };
        return Some(NameMatch {
            tier,
            refinement: contiguous_refinement(name_len, query_len, position, depth),
        });
    }

    // Aliases the document declares it answers to. The best alias wins, and
    // its refinement is measured against that alias, not the file name.
    let alias_match = alias_keys
        .iter()
        .filter_map(|alias| {
            let position = alias.find(query_key)?;
            let alias_len = alias.chars().count();
            let tier = if alias.as_ref() == query_key {
                MatchTier::AliasExact
            } else if position == 0 {
                MatchTier::AliasPrefix
            } else {
                MatchTier::AliasSubstring
            };
            Some(NameMatch {
                tier,
                refinement: contiguous_refinement(alias_len, query_len, position, depth),
            })
        })
        .max_by_key(|found| (found.tier, found.refinement));
    if alias_match.is_some() {
        return alias_match;
    }

    // A parent directory name, then anywhere else in the path. The final
    // branch searches the whole path, not just the parent portion, so a query
    // straddling a component boundary ("cs/re" in "docs/readme.md") still
    // matches — as the weakest kind of match, which is what it is.
    let parent = &path_key[..path_key.len() - name.len()];
    let in_directory_name = parent
        .split('/')
        .any(|component| !component.is_empty() && component.contains(query_key));
    let position = path_key.find(query_key)?;
    let field_len = if in_directory_name {
        parent.chars().count()
    } else {
        path_key.chars().count()
    };
    Some(NameMatch {
        tier: if in_directory_name {
            MatchTier::DirectorySubstring
        } else {
            MatchTier::PathSubstring
        },
        refinement: contiguous_refinement(field_len, query_len, position, depth),
    })
}

/// Match `query_key` as a subsequence (fuzzy), for queries that skip
/// characters: `fsc` finding `file-search-cache`. Only reached when
/// contiguous matching left too few results, so it never displaces an exact
/// hit — it only fills in behind one.
pub(crate) fn match_fuzzy(path_key: &str, query_key: &str) -> Option<NameMatch> {
    if query_key.is_empty() {
        return None;
    }
    let query: Vec<char> = query_key.chars().collect();
    let (name, depth) = basename_of(path_key);

    // Prefer an alignment inside the file's own name; fall back to the path.
    let (candidate, tier) = match align(&name.chars().collect::<Vec<_>>(), &query) {
        Some(positions) => (Some((name, positions)), MatchTier::NameFuzzy),
        None => (
            align(&path_key.chars().collect::<Vec<_>>(), &query)
                .map(|positions| (path_key, positions)),
            MatchTier::PathFuzzy,
        ),
    };
    let (field, positions) = candidate?;
    let field_chars: Vec<char> = field.chars().collect();

    // Tightly clustered characters read as a real abbreviation; scattered
    // ones are usually a coincidence.
    let span = positions.last()? - positions.first()? + 1;
    let compactness = scaled(positions.len(), span, POSITION_BUDGET);
    let boundary_hits = positions
        .iter()
        .filter(|&&index| index == 0 || is_separator(field_chars[index - 1]))
        .count();
    let boundary_points = scaled(boundary_hits, positions.len(), TIGHTNESS_BUDGET);
    let head_points = scaled(
        field_chars.len().saturating_sub(*positions.first()?),
        field_chars.len(),
        DEPTH_BUDGET / (1 + depth as i64),
    );

    Some(NameMatch {
        tier,
        refinement: compactness + boundary_points + head_points,
    })
}

/// Align every character of `query` against `candidate` in order, returning
/// the matched indices.
///
/// Two greedy walks are tried. The first prefers positions that start a word,
/// so `fsc` lands on `**f**ile-**s**earch-**c**ache` rather than on the first
/// stray `s` inside `file`. Word starts are not always reachable, so a plain
/// leftmost walk is the fallback. Greedy rather than an optimal alignment:
/// this runs over every indexed path, and fuzzy is already a fallback tier
/// whose job is to surface a plausible candidate, not to rank a large field.
fn align(candidate: &[char], query: &[char]) -> Option<Vec<usize>> {
    align_with(candidate, query, true).or_else(|| align_with(candidate, query, false))
}

fn align_with(candidate: &[char], query: &[char], prefer_boundaries: bool) -> Option<Vec<usize>> {
    let mut positions = Vec::with_capacity(query.len());
    let mut cursor = 0usize;

    for &wanted in query {
        let mut leftmost = None;
        let mut boundary = None;
        for index in cursor..candidate.len() {
            if candidate[index] != wanted {
                continue;
            }
            if leftmost.is_none() {
                leftmost = Some(index);
            }
            if prefer_boundaries
                && boundary.is_none()
                && (index == 0 || is_separator(candidate[index - 1]))
            {
                boundary = Some(index);
            }
            if !prefer_boundaries || boundary.is_some() {
                break;
            }
        }
        let chosen = if prefer_boundaries {
            boundary.or(leftmost)?
        } else {
            leftmost?
        };
        positions.push(chosen);
        cursor = chosen + 1;
    }

    (!positions.is_empty()).then_some(positions)
}

/// Whether `reference` names `path_key`: a reference containing `/` must be a
/// trailing run of whole path components, a bare one must be the final
/// component. Shared by resolution and by alias comparison.
pub(crate) fn reference_matches(path_key: &str, reference_key: &str) -> bool {
    if reference_key.contains('/') {
        path_key == reference_key
            || path_key
                .strip_suffix(reference_key)
                .is_some_and(|prefix| prefix.ends_with('/'))
    } else {
        path_key.rsplit('/').next() == Some(reference_key)
    }
}

/// Candidate keys for a reference: the reference itself, plus the `.md` form
/// when its final segment has no extension (`[[note]]` resolves `note.md`).
pub(crate) fn reference_keys(reference: &str) -> Vec<String> {
    let trimmed = reference.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        return Vec::new();
    }
    let key = normalize_key(trimmed);
    let last_segment = key.rsplit('/').next().unwrap_or(&key);
    if last_segment.contains('.') {
        vec![key]
    } else {
        let with_md = format!("{key}.md");
        vec![key, with_md]
    }
}

/// Deterministic choice among paths matching the same reference: fewest path
/// components wins, then the shorter path, then the lexicographically smaller
/// one. This is the "shortest path wins" rule for duplicate basenames.
pub(crate) fn shorter_path(a: &str, b: &str) -> std::cmp::Ordering {
    let depth_a = a.matches('/').count();
    let depth_b = b.matches('/').count();
    depth_a
        .cmp(&depth_b)
        .then(a.len().cmp(&b.len()))
        .then(a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn aliases(values: &[&str]) -> Vec<Arc<str>> {
        values
            .iter()
            .map(|value| Arc::from(normalize_key(value).as_str()))
            .collect()
    }

    fn tier(path: &str, query: &str) -> MatchTier {
        match_contiguous(&normalize_key(path), &[], &normalize_key(query))
            .expect("expected a match")
            .tier
    }

    #[test]
    fn tiers_order_name_over_directory_over_path() {
        assert_eq!(tier("docs/note.md", "note.md"), MatchTier::NameExact);
        // The extension is hidden in the UI and appended by the resolver, so
        // naming the stem is naming the file.
        assert_eq!(tier("docs/note.md", "note"), MatchTier::NameExact);
        assert_eq!(tier("docs/note.md", "not"), MatchTier::NamePrefix);
        assert_eq!(tier("docs/my-note.md", "note"), MatchTier::NameSubstring);
        assert_eq!(tier("docs/readme.md", "docs"), MatchTier::DirectorySubstring);
        // Spans the boundary between two components, so it is neither a
        // directory-name nor a file-name match.
        assert_eq!(tier("docs/readme.md", "cs/re"), MatchTier::PathSubstring);
    }

    #[test]
    fn name_match_outranks_directory_match() {
        let name = match_contiguous(&normalize_key("other/note.md"), &[], "note").unwrap();
        let dir = match_contiguous(&normalize_key("note/other.md"), &[], "note").unwrap();
        assert!(name.score(0) > dir.score(HISTORY_MAX));
    }

    #[test]
    fn shallower_and_earlier_matches_rank_higher_within_a_tier() {
        let shallow = match_contiguous(&normalize_key("note.md"), &[], "note").unwrap();
        let deep = match_contiguous(&normalize_key("a/b/c/note.md"), &[], "note").unwrap();
        assert!(shallow.score(0) > deep.score(0));

        // Both are NameSubstring; only the match position differs.
        let early = match_contiguous(&normalize_key("a-note-b.md"), &[], "note").unwrap();
        let late = match_contiguous(&normalize_key("aaaa-note.md"), &[], "note").unwrap();
        assert!(early.score(0) > late.score(0));
    }

    #[test]
    fn git_history_only_breaks_ties_within_a_tier() {
        let a = match_contiguous(&normalize_key("docs/note.md"), &[], "note").unwrap();
        let b = match_contiguous(&normalize_key("docs/note.md"), &[], "note").unwrap();
        assert!(a.score(HISTORY_MAX) > b.score(0), "history breaks a tie");

        let better_tier = match_contiguous(&normalize_key("note.md"), &[], "note.md").unwrap();
        let worse_tier = match_contiguous(&normalize_key("my-note.md"), &[], "note.md").unwrap();
        assert!(
            better_tier.score(0) > worse_tier.score(HISTORY_MAX),
            "history must not lift a weaker tier above a stronger one"
        );
    }

    #[test]
    fn aliases_match_when_the_file_name_does_not() {
        let alias_keys = aliases(&["Design Doc", "Spec"]);
        let found =
            match_contiguous(&normalize_key("docs/20260805.md"), &alias_keys, "spec").unwrap();
        assert_eq!(found.tier, MatchTier::AliasExact);

        let partial =
            match_contiguous(&normalize_key("docs/20260805.md"), &alias_keys, "design").unwrap();
        assert_eq!(partial.tier, MatchTier::AliasPrefix);
    }

    #[test]
    fn a_real_name_match_outranks_an_alias_match() {
        let alias_keys = aliases(&["note"]);
        let by_name = match_contiguous(&normalize_key("note.md"), &[], "note").unwrap();
        let by_alias = match_contiguous(&normalize_key("other.md"), &alias_keys, "note").unwrap();
        assert!(by_name.score(0) > by_alias.score(HISTORY_MAX));
    }

    #[test]
    fn fuzzy_matches_a_skipping_query_and_prefers_word_starts() {
        let acronym = match_fuzzy(&normalize_key("file-search-cache.rs"), "fsc");
        assert!(acronym.is_some(), "acronym query should align on word starts");

        let scattered = match_fuzzy(&normalize_key("affixes/silly/cat.md"), "fsc").unwrap();
        assert!(
            acronym.unwrap().score(0) > scattered.score(0),
            "a tight, boundary-aligned match must outrank a scattered one"
        );
    }

    #[test]
    fn fuzzy_rejects_a_query_whose_characters_are_out_of_order() {
        assert!(match_fuzzy(&normalize_key("file-search.rs"), "hcraes").is_none());
    }

    #[test]
    fn fuzzy_never_outranks_a_contiguous_match() {
        let exact = match_contiguous(&normalize_key("a/b/c/d/search.rs"), &[], "search").unwrap();
        let fuzzy = match_fuzzy(&normalize_key("search.rs"), "search").unwrap();
        assert!(exact.score(0) > fuzzy.score(HISTORY_MAX));
    }

    #[test]
    fn empty_query_matches_everything_and_defers_to_history() {
        let found = match_contiguous(&normalize_key("docs/note.md"), &[], "").unwrap();
        assert_eq!(found.refinement, 0);
        assert!(found.score(HISTORY_MAX) > found.score(0));
        assert!(match_fuzzy(&normalize_key("docs/note.md"), "").is_none());
    }

    #[test]
    fn reference_matching_requires_whole_component_suffixes() {
        assert!(reference_matches("guides/docs/note.md", "docs/note.md"));
        assert!(!reference_matches("mydocs/note.md", "docs/note.md"));
        assert!(reference_matches("docs/note.md", "note.md"));
        assert!(!reference_matches("docs/mynote.md", "note.md"));
    }

    #[test]
    fn reference_keys_add_the_markdown_form_only_when_extensionless() {
        assert_eq!(reference_keys("note"), vec!["note", "note.md"]);
        assert_eq!(reference_keys("note.md"), vec!["note.md"]);
        assert_eq!(reference_keys("  /docs/note  "), vec!["docs/note", "docs/note.md"]);
        assert!(reference_keys("   ").is_empty());
    }
}
