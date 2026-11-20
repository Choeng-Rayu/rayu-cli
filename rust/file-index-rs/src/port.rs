//! The Rust port of `rayu/src/native-ts/file-index/`.
//!
//! The original is a pure-TypeScript reimplementation of a nucleo-backed native
//! module. All offsets, lengths and comparisons in it are UTF-16 code units, so
//! this port scans `encode_utf16()` rather than UTF-8 bytes.

#![forbid(unsafe_code)]

use std::collections::HashSet;

const SCORE_MATCH: i64 = 16;
const BONUS_BOUNDARY: i64 = 8;
const BONUS_CAMEL: i64 = 6;
const BONUS_CONSECUTIVE: i64 = 4;
const BONUS_FIRST_CHAR: i64 = 8;
const PENALTY_GAP_START: i64 = 3;
const PENALTY_GAP_EXTENSION: i64 = 1;

const TOP_LEVEL_CACHE_LIMIT: usize = 100;
const MAX_QUERY_LEN: usize = 64;

/// Port of `yieldToEventLoop` (`rayu/src/native-ts/file-index/index.ts:325`).
pub async fn yield_to_event_loop() -> Result<(), String> {
    Ok(())
}

/// Port of class `FileIndex` (`rayu/src/native-ts/file-index/index.ts:43`): holds the instance state.
#[derive(Default)]
pub struct FileIndex {
    paths: Vec<String>,
    lower_paths: Vec<String>,
    char_bits: Vec<i32>,
    path_lens: Vec<u16>,
    top_level_cache: Option<Vec<TopLevelEntry>>,
    ready_count: usize,
}

struct TopLevelEntry {
    path: String,
    score: f64,
}

impl FileIndex {
    /// Port of `FileIndex` constructor (`rayu/src/native-ts/file-index/index.ts:43`).
    pub fn new() -> Result<Self, String> {
        Ok(Self::default())
    }

    /// Port of `FileIndex.loadFromFileList` (`rayu/src/native-ts/file-index/index.ts:58`).
    pub fn load_from_file_list(&mut self, file_list: Vec<String>) -> Result<(), String> {
        let mut seen = HashSet::new();
        let mut paths = Vec::new();
        for line in file_list {
            if !line.is_empty() && seen.insert(line.clone()) {
                paths.push(line);
            }
        }
        self.build_index(paths);
        Ok(())
    }

    /// Port of `FileIndex.loadFromFileListAsync` (`rayu/src/native-ts/file-index/index.ts:83`).
    ///
    /// The promises cross the recorded bindings as `{}`, and the resolved value is
    /// `undefined`; the index itself is built identically to the sync variant.
    pub fn load_from_file_list_async(
        &mut self,
        file_list: Vec<String>,
    ) -> Result<serde_json::Value, String> {
        self.load_from_file_list(file_list)?;
        Ok(serde_json::json!({ "queryable": {}, "done": {} }))
    }

    /// Port of `FileIndex.search` (`rayu/src/native-ts/file-index/index.ts:173`).
    pub fn search(&mut self, query: String, limit: f64) -> Result<Vec<serde_json::Value>, String> {
        search_impl(self, query, limit)
    }

    fn build_index(&mut self, paths: Vec<String>) {
        self.reset_arrays(paths);
        for i in 0..self.paths.len() {
            self.index_path(i);
        }
        self.ready_count = self.paths.len();
    }

    fn reset_arrays(&mut self, paths: Vec<String>) {
        let n = paths.len();
        self.paths = paths;
        self.lower_paths = vec![String::new(); n];
        self.char_bits = vec![0; n];
        self.path_lens = vec![0; n];
        self.ready_count = 0;
        self.top_level_cache = Some(compute_top_level_entries(
            &self.paths,
            TOP_LEVEL_CACHE_LIMIT,
        ));
    }

    fn index_path(&mut self, i: usize) {
        let lp = js_to_lowercase(&self.paths[i]);
        self.path_lens[i] = utf16_len(&lp) as u16;
        let mut bits: i32 = 0;
        for unit in lp.encode_utf16() {
            let c = i32::from(unit);
            if (97..=122).contains(&c) {
                bits |= 1 << (c - 97);
            }
        }
        self.lower_paths[i] = lp;
        self.char_bits[i] = bits;
    }
}

fn search_impl(
    index: &FileIndex,
    query: String,
    limit: f64,
) -> Result<Vec<serde_json::Value>, String> {
    if limit <= 0.0 {
        return Ok(Vec::new());
    }

    if query.is_empty() {
        let Some(cache) = &index.top_level_cache else {
            return Ok(Vec::new());
        };
        return Ok(cache
            .iter()
            .take(js_slice_len(limit))
            .map(|entry| serde_json::json!({ "path": entry.path, "score": entry.score }))
            .collect());
    }

    // Smart case: lowercase query -> case-insensitive; any uppercase -> case-sensitive.
    let case_sensitive = query != js_to_lowercase(&query);
    let needle = if case_sensitive {
        query.clone()
    } else {
        js_to_lowercase(&query)
    };
    let needle_units: Vec<u16> = needle.encode_utf16().collect();
    let n_len = needle_units.len().min(MAX_QUERY_LEN);
    let mut needle_bitmap: i32 = 0;
    for &unit in &needle_units[..n_len] {
        let c = i32::from(unit);
        if (97..=122).contains(&c) {
            needle_bitmap |= 1 << (c - 97);
        }
    }

    let score_ceiling = n_len as i64 * (SCORE_MATCH + BONUS_BOUNDARY) + BONUS_FIRST_CHAR + 32;

    // Top-k: ascending by fuzz score; threshold is the worst kept score.
    // `None` is JS `undefined`, which makes every `score > threshold` false.
    let mut top_k: Vec<(usize, i64)> = Vec::new();
    let mut threshold: Option<i64> = None;
    let mut positions: Vec<usize> = vec![0; n_len];

    let paths = &index.paths;
    let lower_paths = &index.lower_paths;
    let char_bits = &index.char_bits;
    let path_lens = &index.path_lens;
    let ready_count = index.ready_count;

    'outer: for i in 0..ready_count {
        if (char_bits[i] & needle_bitmap) != needle_bitmap {
            continue;
        }

        let haystack = if case_sensitive {
            paths[i].encode_utf16().collect::<Vec<u16>>()
        } else {
            lower_paths[i].encode_utf16().collect::<Vec<u16>>()
        };

        let Some(first) = index_of_unit(&haystack, needle_units[0], 0) else {
            continue;
        };
        positions[0] = first;
        let mut gap_penalty: i64 = 0;
        let mut consec_bonus: i64 = 0;
        let mut prev = first;
        for j in 1..n_len {
            let Some(pos) = index_of_unit(&haystack, needle_units[j], prev + 1) else {
                continue 'outer;
            };
            positions[j] = pos;
            let gap = (pos - prev - 1) as i64;
            if gap == 0 {
                consec_bonus += BONUS_CONSECUTIVE;
            } else {
                gap_penalty += PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION;
            }
            prev = pos;
        }

        if top_k.len() as f64 == limit
            && threshold.is_some_and(|t| score_ceiling + consec_bonus - gap_penalty <= t)
        {
            continue;
        }

        let path_units: Vec<u16> = paths[i].encode_utf16().collect();
        let h_len = i64::from(path_lens[i]);
        let mut score = n_len as i64 * SCORE_MATCH + consec_bonus - gap_penalty;
        score += score_bonus_at(&path_units, positions[0], true);
        for &pos in &positions[1..n_len] {
            score += score_bonus_at(&path_units, pos, false);
        }
        score += (32 - (h_len >> 2)).max(0);

        if (top_k.len() as f64) < limit {
            // Ascending insert (the JS `push` then one-time `sort` when full).
            let lo = top_k.partition_point(|&(_, s)| s <= score);
            top_k.insert(lo, (i, score));
            if top_k.len() as f64 == limit {
                top_k.sort_by_key(|&(_, s)| s);
                threshold = top_k.first().map(|&(_, s)| s);
            }
        } else if threshold.is_none_or(|t| score > t) {
            let mut lo = 0;
            let mut hi = top_k.len();
            while lo < hi {
                let mid = (lo + hi) >> 1;
                if top_k[mid].1 < score {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            top_k.insert(lo, (i, score));
            // The splice above guarantees at least one element, so `shift` is safe.
            top_k.remove(0);
            threshold = top_k.first().map(|&(_, s)| s);
        }
    }

    // Ascending -> descending, stable within ties.
    top_k.sort_by_key(|&(_, score)| std::cmp::Reverse(score));

    let match_count = top_k.len();
    let denom = match_count.max(1) as f64;
    let mut results = Vec::with_capacity(match_count);
    for (i, &(path_index, _)) in top_k.iter().enumerate() {
        let path = &paths[path_index];
        let position_score = i as f64 / denom;
        let final_score = if path.contains("test") {
            (position_score * 1.05).min(1.0)
        } else {
            position_score
        };
        results.push(serde_json::json!({ "path": path, "score": final_score }));
    }

    Ok(results)
}

fn index_of_unit(haystack: &[u16], needle: u16, from: usize) -> Option<usize> {
    if from >= haystack.len() {
        return None;
    }
    haystack[from..]
        .iter()
        .position(|&unit| unit == needle)
        .map(|offset| from + offset)
}

/// Boundary/camelCase bonus for a match at `pos` in the original-case path.
fn score_bonus_at(path: &[u16], pos: usize, first: bool) -> i64 {
    if pos == 0 {
        return if first { BONUS_FIRST_CHAR } else { 0 };
    }
    let prev = path[pos - 1];
    if is_boundary(prev) {
        return BONUS_BOUNDARY;
    }
    if is_lower(prev) && is_upper(path[pos]) {
        return BONUS_CAMEL;
    }
    0
}

fn is_boundary(code: u16) -> bool {
    matches!(code, 47 | 92 | 45 | 95 | 46 | 32)
}

fn is_lower(code: u16) -> bool {
    (97..=122).contains(&code)
}

fn is_upper(code: u16) -> bool {
    (65..=90).contains(&code)
}

/// JS `String.prototype.slice(0, limit)` length: truncates toward zero, NaN -> 0,
/// Infinity -> everything.
fn js_slice_len(limit: f64) -> usize {
    if limit.is_nan() {
        0
    } else if limit.is_infinite() {
        usize::MAX
    } else {
        limit.trunc() as usize
    }
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `String.prototype.toLowerCase`: per-character full case mapping plus the
/// Final_Sigma context rule, which Rust's `str::to_lowercase` does not apply.
fn js_to_lowercase(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == '\u{03a3}' {
            let prev_cased = i > 0 && is_cased(chars[i - 1]);
            let next_cased = chars.get(i + 1).is_some_and(|&next| is_cased(next));
            out.push(if prev_cased && !next_cased {
                '\u{03c2}'
            } else {
                '\u{03c3}'
            });
        } else {
            out.extend(c.to_lowercase());
        }
    }
    out
}

fn is_cased(c: char) -> bool {
    c.is_lowercase() || c.is_uppercase()
}

/// Extract unique top-level path segments, sorted by (length asc, then UTF-16 order).
fn compute_top_level_entries(paths: &[String], limit: usize) -> Vec<TopLevelEntry> {
    let mut seen = HashSet::new();
    let mut top_level: Vec<String> = Vec::new();
    for path in paths {
        let end = path
            .encode_utf16()
            .position(|unit| unit == 47 || unit == 92)
            .unwrap_or_else(|| utf16_len(path));
        let segment = utf16_slice(path, 0, end);
        if !segment.is_empty() && seen.insert(segment.clone()) {
            top_level.push(segment);
            if top_level.len() >= limit {
                break;
            }
        }
    }

    top_level.sort_by(|a, b| match utf16_len(a).cmp(&utf16_len(b)) {
        std::cmp::Ordering::Equal => cmp_utf16(a, b),
        other => other,
    });

    top_level
        .into_iter()
        .take(limit)
        .map(|path| TopLevelEntry { path, score: 0.0 })
        .collect()
}

/// JS `slice(0, end)` on the UTF-16 code units of a string.
fn utf16_slice(s: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let end = end.min(units.len());
    if start >= end {
        return String::new();
    }
    String::from_utf16_lossy(&units[start..end])
}

/// JS `<` ordering: lexicographic over UTF-16 code units.
fn cmp_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn search(paths: &[&str], query: &str, limit: f64) -> Vec<serde_json::Value> {
        let mut index = FileIndex::new().unwrap();
        index
            .load_from_file_list(paths.iter().map(|p| p.to_string()).collect())
            .unwrap();
        index.search(query.to_string(), limit).unwrap()
    }

    #[test]
    fn empty_query_returns_top_level_segments() {
        let out = search(&["src/b.ts", "readme.md", "src/a.ts", ""], "", 10.0);
        let paths: Vec<&str> = out.iter().map(|v| v["path"].as_str().unwrap()).collect();
        assert_eq!(paths, vec!["src", "readme.md"]);
    }

    #[test]
    fn deduplicates_and_ranks_matches() {
        let out = search(&["abc.ts", "a_b_c.ts", "xyz.ts"], "abc", 10.0);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["path"], "abc.ts");
        assert_eq!(out[0]["score"], 0.0);
    }

    #[test]
    fn smart_case_is_case_sensitive_with_uppercase() {
        assert!(search(&["ABC.ts"], "abc", 10.0).len() == 1);
        assert!(search(&["abc.ts"], "ABC", 10.0).is_empty());
    }

    #[test]
    fn js_lowercase_applies_final_sigma() {
        assert_eq!(js_to_lowercase("ΟΔΟΣ"), "οδο\u{3c2}");
        assert_eq!(js_to_lowercase("ΑΣΑ"), "α\u{3c3}α");
        assert_eq!(js_to_lowercase("İ"), "i\u{307}");
    }
}
